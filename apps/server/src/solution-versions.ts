import { HTML_CONTENT_TYPES, physicalRunFile } from '@dreamatic/project-data';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { plannedImages } from './design-images.js';
import { showcaseDirectionMarkdown, type ShowcaseDirection, type ShowcaseWork, validateShowcaseDirection, validateShowcaseHtml, type GeneratedShowcaseImage } from './showcase.js';

const page = 'final/00-index.html';
const design = 'design.md';
const exhibition = 'showcase.md';
const manifestPath = 'artifacts/artifact-manifest.json';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const versionId = /^[a-f0-9]{64}$/u;

export interface SolutionVersion {
  id: string;
  runId: string;
  title: string;
  createdAt: string;
  parentIds: string[];
  taskId?: string;
  designPath: string;
  showcasePath: string;
  exhibitionPath?: string;
  exhibitionStatus: 'original' | 'recovered' | 'missing';
  coverPath: string;
  heroId: string;
  images: Array<{ id: string; path: string }>;
  videos?: Array<{ id: string; path: string; title: string }>;
  works?: ShowcaseWork[];
  files: Record<string, string>;
}

export async function solutionProjectDirectory(workspace: string, runId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) throw new Error('Invalid run id');
  const runs = await realpath(join(workspace, 'runs'));
  const root = join(runs, runId);
  if (await realpath(root) !== root) throw new Error('Invalid project directory');
  return root;
}

async function versionDirectory(root: string, id?: string) {
  const versions = join(root, 'solution-versions');
  if (await realpath(versions) !== versions) throw new Error('Invalid version directory');
  if (!id) return versions;
  if (!versionId.test(id)) throw new Error('Invalid version ID');
  const version = join(versions, id);
  if (await realpath(version) !== version) throw new Error('Invalid version directory');
  return version;
}

async function read(root: string, path: string) {
  return readFile(await physicalRunFile(root, path));
}

async function optional<T>(work: Promise<T>): Promise<T | undefined> {
  return work.catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function optionalJson(root: string, path: string) {
  const bytes = await optional(read(root, path));
  if (!bytes) return;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

async function collectDelivery(root: string) {
  const designBytes = await read(root, design);
  const html = await read(root, page);
  const manifest = JSON.parse((await read(root, manifestPath)).toString('utf8'));
  if (manifest.presentation?.mode !== 'gallery' || !Array.isArray(manifest.artifacts)) return;
  const planned = plannedImages(designBytes.toString('utf8'));
  const generated: Record<string, GeneratedShowcaseImage> = Object.create(null);
  const files = new Map([[design, designBytes], [page, html]]);
  for (const { id } of planned) {
    const asset = manifest.artifacts.find((entry: { deliverableId?: string }) => entry?.deliverableId === id);
    if (typeof asset?.path !== 'string' || !/^artifacts\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/iu.test(asset.path) || files.has(asset.path)) return;
    const bytes = await read(root, asset.path);
    const digest = hash(bytes);
    if (digest !== asset.digest) return;
    generated[id] = { path: asset.path, digest };
    files.set(asset.path, bytes);
  }

  const curated = manifest.showcase?.works
    ? validateShowcaseDirection({ ...manifest.showcase, markdown: 'Imported exhibition' }, planned, generated)
    : undefined;
  const visibleIds = await validateShowcaseHtml(root, html.toString('utf8'), { works: curated?.works ?? planned }, generated);
  let ids = curated?.works.map(work => work.id) ?? visibleIds;
  let heroId = curated?.heroId ?? visibleIds[0]!;
  const existing = await optional(read(root, exhibition));
  let exhibitionStatus: SolutionVersion['exhibitionStatus'] = 'missing';
  const saved = await optionalJson(root, '.showcase-direction.json');
  const completed = (await optionalJson(root, 'pipeline-state.json'))?.completed;
  if (saved && completed) {
    const paired = typeof saved.fingerprint === 'string' &&
      completed?.builder === `v2:${hash(saved.fingerprint + html.toString('utf8'))}`;
    const matches = planned.every(({ id }) => saved.assets?.[id]?.path === generated[id]?.path && saved.assets?.[id]?.digest === generated[id]?.digest);
    if (paired && matches) {
      const direction = validateShowcaseDirection(saved.direction, planned, generated);
      if (!curated || (direction.heroId === curated.heroId && JSON.stringify(direction.works) === JSON.stringify(curated.works))) {
        const recovered = Buffer.from(showcaseDirectionMarkdown(direction));
        if (manifest.showcase?.direction === exhibition && existing?.equals(recovered)) {
          files.set(exhibition, existing);
          exhibitionStatus = 'original';
        } else {
          files.set(exhibition, recovered);
          exhibitionStatus = 'recovered';
        }
        ids = direction.works.map(work => work.id);
        heroId = direction.heroId;
      }
    }
  }
  return { files, exhibitionStatus, heroId, images: ids.map(id => ({ id, path: generated[id]!.path })), coverPath: generated[heroId]!.path };
}

/** Import only completed deliveries. Layout and task state never determine version identity. */
export async function snapshotCompletedDesign(workspace: string, runId: string) {
  const root = await optional(solutionProjectDirectory(workspace, runId));
  if (!root) return;
  const stateBytes = await optional(read(root, 'run-state.json'));
  if (!stateBytes) return;
  const state = JSON.parse(stateBytes.toString('utf8'));
  if (state.status !== 'completed' || state.stages?.build !== 'completed') return;
  const delivery = await collectDelivery(root).catch(() => undefined);
  if (!delivery || !(await read(root, 'run-state.json')).equals(stateBytes)) return;
  const files = Object.fromEntries([...delivery.files].map(([path, bytes]) => [path, hash(bytes)]));
  const id = hash(JSON.stringify(files));
  const brief = await optional(read(root, 'brief.json'));
  const title = brief ? JSON.parse(brief.toString('utf8')).title : undefined;
  const version: SolutionVersion = {
    id, runId, title: typeof title === 'string' ? title : 'Design proposal',
    createdAt: typeof state.updatedAt === 'string' ? state.updatedAt : new Date().toISOString(),
    parentIds: [], designPath: design, showcasePath: page, coverPath: delivery.coverPath, heroId: delivery.heroId,
    ...(delivery.files.has(exhibition) ? { exhibitionPath: exhibition } : {}),
    exhibitionStatus: delivery.exhibitionStatus, images: delivery.images, files
  };
  await publishVersion(root, version, delivery.files);
}

async function publishVersion(root: string, version: SolutionVersion, files: Map<string, Buffer>, signal?: AbortSignal) {
  await mkdir(join(root, 'solution-versions'), { recursive: true });
  const versions = await versionDirectory(root);
  if (await optional(versionDirectory(root, version.id))) return;
  const temporary = join(versions, `.pending-${randomUUID()}`);
  await mkdir(temporary);
  try {
    for (const [path, bytes] of files) {
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(join(temporary, 'version.json'), JSON.stringify(version, null, 2));
    signal?.throwIfAborted();
    await rename(temporary, join(versions, version.id)).catch(error => {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function metadata(root: string, id: string) {
  if (!versionId.test(id)) throw new Error('Invalid version ID');
  const path = await optional(versionDirectory(root, id)) ?? await batchVersionDirectory(root, id);
  const version: SolutionVersion = JSON.parse((await read(path, 'version.json')).toString('utf8'));
  if (version.id !== id) throw new Error('Invalid version metadata');
  return { path, version: { ...version, heroId: version.heroId ?? version.images.find(image => image.path === version.coverPath)?.id } };
}

export async function solutionWorks(workspace: string, version: SolutionVersion) {
  if (version.works) return version.works;
  if (!version.exhibitionPath) return [];
  const markdown = (await readSolutionFile(workspace, version.runId, version.id, version.exhibitionPath)).bytes.toString('utf8');
  const inventory = markdown.split('All works in narrative order:\n')[1]?.split(/\r?\n\s*\r?\n/u)[0] ?? '';
  return [...inventory.matchAll(/^- ([a-zA-Z0-9_-]+) — ([^;]+); ([^;]+); (.+)$/gmu)].map(match => ({ id: match[1]!, role: match[2]!, section: match[3]!, purpose: match[4]! }));
}

export async function listSolutionVersions(workspace: string, runId: string) {
  await snapshotCompletedDesign(workspace, runId);
  const root = await solutionProjectDirectory(workspace, runId);
  const folder = await optional(versionDirectory(root));
  if (!folder) return [];
  const entries = await readdir(folder, { withFileTypes: true });
  const ids = entries.filter(entry => entry.isDirectory() && versionId.test(entry.name)).map(entry => entry.name);
  for (const entry of entries.filter(entry => entry.isDirectory() && /^batch-[a-f0-9]{62}$/u.test(entry.name))) {
    const batch = join(folder, entry.name);
    ids.push(...(await readdir(batch, { withFileTypes: true })).filter(child => child.isDirectory() && versionId.test(child.name) && child.name.startsWith(entry.name.slice(6))).map(child => child.name));
  }
  const versions = await Promise.all(ids.map(id => metadata(root, id)));
  return (await Promise.all(versions.map(async ({ version }) => ({ ...version, works: await solutionWorks(workspace, version).catch(() => []) })))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readSolutionFile(workspace: string, runId: string, id: string, file: string) {
  const { path, version } = await metadata(await solutionProjectDirectory(workspace, runId), id);
  if (version.runId !== runId || !Object.hasOwn(version.files, file)) throw new Error('Unknown version file');
  const bytes = await read(path, file);
  if (hash(bytes) !== version.files[file]) throw new Error('Version file changed');
  return { bytes, contentType: HTML_CONTENT_TYPES[extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8' };
}

export async function findSolutionVersion(workspace: string, runId: string, id: string) {
  const entry = await optional(metadata(await solutionProjectDirectory(workspace, runId), id));
  if (entry && entry.version.runId !== runId) throw new Error('Invalid version project');
  return entry?.version;
}

const finalSelection = 'final-solution.json';

export async function getFinalSolutionId(workspace: string, runId: string): Promise<string | null> {
  const root = await solutionProjectDirectory(workspace, runId);
  const bytes = await optional(read(root, finalSelection));
  if (!bytes) return null;
  const { versionId: id } = JSON.parse(bytes.toString('utf8'));
  if (typeof id !== 'string' || !versionId.test(id)) throw new Error('Invalid final solution selection');
  return id;
}

export async function setFinalSolutionId(workspace: string, runId: string, id: unknown) {
  if (typeof id !== 'string' || !versionId.test(id)) throw new Error('Invalid version ID');
  const version = await findSolutionVersion(workspace, runId, id);
  if (!version) throw new Error('Unknown solution version');
  await readSolutionFile(workspace, runId, id, version.showcasePath);
  const root = await solutionProjectDirectory(workspace, runId);
  const temporary = join(root, `.${finalSelection}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ versionId: id }), { flag: 'wx' });
    await rename(temporary, join(root, finalSelection));
  } finally { await rm(temporary, { force: true }); }
  return id;
}

async function batchVersionDirectory(root: string, id: string) {
  const versions = await versionDirectory(root);
  const path = join(versions, 'batch-' + id.slice(0, 62), id);
  if (await realpath(path) !== path) throw new Error('Invalid version directory');
  return path;
}

export interface SolutionDelivery {
  designText: string;
  html: string;
  direction: ShowcaseDirection;
  generated: Record<string, GeneratedShowcaseImage>;
  staging: string;
  videoTitles?: Record<string, string>;
}

export async function publishSolutionBatch(input: {
  workspace: string; runId: string; parents: SolutionVersion[]; taskId: string; outputIds: string[];
  deliveries: SolutionDelivery[]; signal: AbortSignal;
}) {
  const { workspace, runId, parents, taskId, outputIds, deliveries, signal } = input;
  if (deliveries.length !== outputIds.length || !outputIds.length) throw new Error('Incomplete solution batch');
  const root = await solutionProjectDirectory(workspace, runId);
  const versions = await versionDirectory(root);
  const batch = join(versions, 'batch-' + outputIds[0]!.slice(0, 62));
  const temporary = join(versions, `.pending-${randomUUID()}`);
  const createdAt = new Date().toISOString();
  await mkdir(temporary);
  try {
    for (const [index, delivery] of deliveries.entries()) {
      signal.throwIfAborted();
      const { designText, html, direction, generated, staging } = delivery;
      const assets = direction.works.map(({ id }) => ({ id, path: generated[id]!.path }));
      const images = assets.filter(({ id }) => generated[id]!.kind !== 'video');
      const videos = assets.filter(({ id }) => generated[id]!.kind === 'video').map(asset => ({ ...asset, title: delivery.videoTitles?.[asset.id] ?? asset.id }));
      const id = outputIds[index]!;
      const target = join(temporary, id);
      const files: Record<string, string> = Object.create(null);
      for (const [path, text] of [[design, designText], [exhibition, showcaseDirectionMarkdown(direction)], [page, html]] as const) {
        const bytes = Buffer.from(text);
        const destination = join(target, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        files[path] = hash(bytes);
      }
      for (const { id, path } of assets) {
        signal.throwIfAborted();
        const bytes = await read(staging, path);
        const checksum = hash(bytes);
        if (checksum !== generated[id]!.digest) throw new Error('Staged material changed');
        const destination = join(target, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        files[path] = checksum;
      }
      const title = /^#\s+(.+)$/mu.exec(designText)?.[1]?.trim() || parents[0]!.title;
      const version: SolutionVersion = {
        id, runId, title, createdAt, parentIds: parents.map(parent => parent.id), taskId,
        designPath: design, showcasePath: page, exhibitionPath: exhibition, exhibitionStatus: 'original',
        coverPath: generated[direction.heroId]!.path, heroId: direction.heroId, images, ...(videos.length ? { videos } : {}), works: direction.works,
        files
      };
      await writeFile(join(target, 'version.json'), JSON.stringify(version, null, 2));
    }
    signal.throwIfAborted();
    await rename(temporary, batch);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
