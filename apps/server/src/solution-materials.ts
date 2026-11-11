import { physicalRunFile } from '@dreamatic/project-data';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { imageDimensions } from './image-edit-size.js';
import { imageBytesKind } from './image-edit.js';
import { projectFileContent, projectFiles } from './project-files.js';
import { composeSolutionShowcase } from './solution-showcase.js';
import { readSolutionFile, solutionWorks, type SolutionVersion } from './solution-versions.js';
import type { GeneratedShowcaseImage } from './showcase.js';
import type { EditActivityReporter } from './edit-activity.js';

export interface MaterialEdit {
  mode: 'integrate' | 'replace';
  fileIds: string[];
  section?: string;
  targetId?: string;
}

interface MaterialFile {
  filename: string;
  title: string;
  extension: string;
  digest: string;
  kind: 'image' | 'video';
  size?: string;
}

export interface MaterialSnapshot { directory: string; files: MaterialFile[] }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function parseMaterialEdit(value: unknown): MaterialEdit {
  const input = value as Partial<MaterialEdit> | null;
  if (!input || !['integrate', 'replace'].includes(input.mode ?? '') || !Array.isArray(input.fileIds) || input.fileIds.length < 1 ||
      input.fileIds.length > 8 || input.fileIds.some(id => typeof id !== 'string' || !id || id.length > 1024) ||
      new Set(input.fileIds).size !== input.fileIds.length ||
      (input.mode === 'replace' && (input.fileIds.length !== 1 || typeof input.targetId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(input.targetId))) ||
      (input.section !== undefined && (typeof input.section !== 'string' || !input.section.trim() || input.section.length > 200))) {
    throw new Error('Connect one solution and select valid materials and a replacement target if needed.');
  }
  return { mode: input.mode!, fileIds: input.fileIds, ...(input.mode === 'integrate' && input.section ? { section: input.section } : {}),
    ...(input.mode === 'replace' && input.targetId ? { targetId: input.targetId } : {}) };
}

function describeMaterial(kind: string, data: Buffer): Pick<MaterialFile, 'kind' | 'extension' | 'size'> {
  const extension = kind.toLowerCase();
  if (extension === 'mp4' && data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', extension };
  if (extension === 'webm' && data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', extension };
  const gif = extension === 'gif' && data.length >= 10 && /GIF8[79]a/u.test(data.toString('ascii', 0, 6));
  const detected = gif ? 'gif' : imageBytesKind(data);
  const dimensions = gif ? { width: data.readUInt16LE(6), height: data.readUInt16LE(8) } : imageDimensions(data);
  if (!detected || !dimensions?.width || !dimensions.height || (detected === 'jpg' ? !['jpg', 'jpeg'].includes(extension) : detected !== extension)) {
    throw new Error('Solution materials must be valid PNG, JPEG, WebP, GIF, MP4 or WebM files.');
  }
  return { kind: 'image', extension: detected, size: `${dimensions.width}x${dimensions.height}` };
}

export async function snapshotMaterials(workspace: string, parent: SolutionVersion, directory: string, edit: MaterialEdit, signal: AbortSignal): Promise<MaterialSnapshot> {
  const works = await solutionWorks(workspace, parent);
  if (edit.section && !works.some(work => work.section === edit.section)) throw new Error('The selected showcase section is unavailable.');
  const imageTarget = parent.images.some(image => image.id === edit.targetId);
  const videoTarget = parent.videos?.some(video => video.id === edit.targetId);
  if (edit.mode === 'replace' && !imageTarget && !videoTarget) throw new Error('The selected material is missing from this solution version.');
  const catalog = await projectFiles(workspace, parent.runId);
  const folder = await mkdtemp(join(directory, '.materials-'));
  try {
    const files: MaterialFile[] = [];
    for (const id of edit.fileIds) {
      signal.throwIfAborted();
      const file = catalog.find(entry => entry.id === id && entry.category === 'assets');
      if (!file || (file.size ?? 0) > 100 * 1024 * 1024) throw new Error('Select a project asset no larger than 100 MB.');
      const { data, kind } = await projectFileContent(workspace, parent.runId, id);
      if (data.length > 100 * 1024 * 1024) throw new Error('Select a project asset no larger than 100 MB.');
      const media = describeMaterial(kind, data);
      if (edit.mode === 'replace' && media.kind !== (imageTarget ? 'image' : 'video')) throw new Error('Replacement materials must have the same type as the target.');
      const filename = `${files.length + 1}.${media.extension}`;
      await writeFile(join(folder, filename), data, { flag: 'wx' });
      files.push({ ...media, filename, title: file.title.replace(/[\r\n]+/gu, ' '), digest: digest(data) });
    }
    return { directory: basename(folder), files };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

export function includeVersionVideos(design: string, videos: Record<string, string>) {
  const old = /^## Showcase videos[ \t]*\r?\n[\s\S]*?(?=^#{1,2} |$(?![\s\S]))/gmu;
  const body = design.replace(old, '').trimEnd();
  const rows = Object.entries(videos);
  if (!rows.length) return design;
  return `${body}\n\n## Showcase videos\n\n${rows.map(([id, title]) => `- ${id}: ${title}`).join('\n')}\n`;
}

function imageSection(id: string, file: MaterialFile) {
  return `## Image: ${id}\n### Introduction\nProject material: ${file.title}\n### Prompt\nUse the supplied project image without modification.\n### Size\n${file.size}\n\n`;
}

export async function buildMaterialRevision(options: {
  repoRoot: string; workspace: string; parent: SolutionVersion; directory: string; staging: string;
  edit: MaterialEdit; snapshot: MaterialSnapshot; signal: AbortSignal; report: EditActivityReporter;
}) {
  const { repoRoot, workspace, parent, directory, staging, edit, snapshot, signal, report } = options;
  const read = async (path: string) => (await readSolutionFile(workspace, parent.runId, parent.id, path)).bytes;
  if (!/^\.materials-[a-zA-Z0-9]+$/u.test(snapshot.directory)) throw new Error('Invalid material snapshot.');
  const folder = join(directory, snapshot.directory);
  if (await realpath(folder) !== folder) throw new Error('Invalid material snapshot.');
  const works = await solutionWorks(workspace, parent);
  const originalTarget = works.find(work => work.id === edit.targetId);
  const previousExhibition = parent.exhibitionPath ? (await read(parent.exhibitionPath)).toString('utf8') : '';
  let designText = (await read(parent.designPath)).toString('utf8');
  const generated: Record<string, GeneratedShowcaseImage> = Object.create(null);
  const videoTitles: Record<string, string> = Object.create(null);
  await mkdir(join(staging, 'artifacts'), { recursive: true });
  for (const asset of [...parent.images.map(image => ({ ...image, title: undefined })), ...(parent.videos ?? [])]) {
    signal.throwIfAborted();
    if (asset.id === edit.targetId) continue;
    const bytes = await read(asset.path);
    await writeFile(join(staging, asset.path), bytes);
    const kind = asset.title === undefined ? 'image' : 'video';
    generated[asset.id] = { path: asset.path, digest: digest(bytes), kind };
    if (asset.title !== undefined) videoTitles[asset.id] = asset.title;
  }

  const materialIds: string[] = [];
  for (const [index, file] of snapshot.files.entries()) {
    signal.throwIfAborted();
    const bytes = await readFile(await physicalRunFile(folder, file.filename));
    if (digest(bytes) !== file.digest) throw new Error('The saved material has changed.');
    let id = edit.targetId ?? `material-${file.digest.slice(0, 12)}-${index + 1}`;
    while (generated[id]) id += '-new';
    const path = `artifacts/${id}-${file.digest.slice(0, 12)}.${file.extension}`;
    await writeFile(join(staging, path), bytes);
    generated[id] = { path, digest: file.digest, kind: file.kind };
    materialIds.push(id);
    if (file.kind === 'video') videoTitles[id] = file.title;
    else if (edit.mode === 'replace') {
      const section = new RegExp(`^## Image: ${id}[ \\t]*\\r?\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'gmu');
      designText = designText.replace(section, () => imageSection(id, file));
    } else {
      designText = `${designText.trimEnd()}\n\n${imageSection(id, file)}`;
    }
    report({ actor: 'system', label: edit.mode === 'replace' ? 'Replace material' : 'Add material', state: 'completed', detail: file.title });
  }
  designText = includeVersionVideos(designText, videoTitles);
  const requestedSection = edit.section ?? originalTarget?.section;
  const preservedOrder = edit.mode === 'replace' && works.length === Object.keys(generated).length ? works.map(work => work.id) : undefined;
  const request = JSON.stringify({
    operation: edit.mode, materialIds, requestedSection, preservedOrder,
    ...(originalTarget ? { preserveTargetRole: originalTarget.role } : {}),
    instruction: 'Use the supplied materials as delivered. Preserve the existing design and unaffected works. Integrate the supplied works or update the selected position, adapting the exhibition to fit the new media.',
  });
  return composeSolutionShowcase({
    repoRoot, staging, signal, request, designText, generated, previousExhibition, videoTitles, report,
    previousHtml: await read(parent.showcasePath),
    materialChanges: { ids: materialIds, kind: edit.mode === 'integrate' ? 'added' : 'replaced' },
    validateDirection(direction) {
      if (preservedOrder && direction.works.some((work, index) => work.id !== preservedOrder[index])) {
        throw new Error('Keep the existing work order when replacing a material.');
      }
      for (const id of materialIds) {
        const work = direction.works.find(entry => entry.id === id)!;
        if (requestedSection && work.section !== requestedSection) throw new Error(`Place "${id}" in the selected section "${requestedSection}".`);
        if (originalTarget && work.role !== originalTarget.role) throw new Error(`Preserve the original role "${originalTarget.role}" for "${id}".`);
      }
    }
  });
}
