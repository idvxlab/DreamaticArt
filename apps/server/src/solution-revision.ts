import type { SolutionImageProgress } from '@dreamatic/project-data';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Type } from 'typebox';
import { createDreamaticAgent } from './agent-session.js';
import { bindFusionCitations, fusionCitationDirectory } from './design-citations.js';
import { dimensions, imageSections, plannedImages } from './design-images.js';
import { imageCapabilityInfo, setting } from './design-pipeline.js';
import { imageBytesKind, imageEditSettings } from './image-edit.js';
import { planImageEdit } from './image-edit-plan.js';
import { imageDimensions } from './image-edit-size.js';
import { requestImage, retryImage } from './image-request.js';
import { imageSlot } from './image-slots.js';
import { imageActivityUsage, type EditActivityReporter } from './edit-activity.js';
import { promptSolutionModel, SolutionModelTimeout } from './solution-model.js';
import { includeVersionVideos } from './solution-materials.js';
import { composeSolutionShowcase } from './solution-showcase.js';
import { readSolutionFile, type SolutionDelivery, type SolutionVersion } from './solution-versions.js';
import type { GeneratedShowcaseImage } from './showcase.js';
import { validateShowcaseDirection, validateShowcaseHtml, validateVersionShowcaseResources } from './showcase.js';

export type SolutionOperation = 'revise' | 'append' | 'fuse' | 'split' | 'replace' | 'recompose';

type ImageAction = { id: string; action: 'reuse' | 'edit' | 'generate'; source?: number; imageId?: string };
interface OutputPlan { design: string; assets: ImageAction[] }
interface Material { version: SolutionVersion; design: string; exhibition: string }
interface SourceImage { source: number; image: ReturnType<typeof plannedImages>[number] }

const appendedPlanSchema = Type.Object({
  additions: Type.String(),
  images: Type.Array(Type.Object({
    id: Type.String({ pattern: '^[a-zA-Z0-9_-]+$' }),
    introduction: Type.String(), prompt: Type.String(), size: Type.String(),
  })),
});

function appendPlan(source: Material, plan: import('typebox').Static<typeof appendedPlanSchema>): OutputPlan {
  const originalImages = plannedImages(source.design);
  const ids = new Set([...originalImages.map(image => image.id), ...(source.version.videos ?? []).map(video => video.id)]);
  const additions = plan.additions.split('\n').map((line, index) => {
    const normalized = line.replace(/^( {0,3})#(?=[ \t])/u, '$1##');
    if (/^ {0,3}##[ \t]+Image:/u.test(normalized)) {
      throw new Error(`additions line ${index + 1} uses the reserved heading "## Image:". Move the new image specification to images.`);
    }
    if (/^ {0,3}##[ \t]+Showcase videos(?:[ \t]+#+)?\s*$/u.test(normalized)) {
      throw new Error(`additions line ${index + 1} uses the reserved heading "## Showcase videos". Remove that heading; the server carries forward existing videos.`);
    }
    return normalized;
  }).join('\n').replace(/^(?:[^\S\n]*\n)+/u, '').trimEnd();
  if (!additions && !plan.images.length) throw new Error('Submit at least one addition.');
  const [maxWidth, maxHeight] = dimensions(setting('DREAMATIC_IMAGE_DEFAULT_SIZE'));
  const sections = plan.images.map(({ id, introduction, prompt, size }) => {
    if (ids.has(id)) throw new Error(`New image ID "${id}" is already in use.`);
    ids.add(id);
    const [width, height] = dimensions(size);
    if (width > maxWidth || height > maxHeight) throw new Error(`Planned image exceeds the configured size budget: ${id}`);
    return `## Image: ${id}\n### Introduction\n${introduction.trim()}\n### Prompt\n${prompt.trim()}\n### Size\n${size.trim()}`;
  });
  const design = `${source.design}\n\n## Additions\n\n${[additions, ...sections].filter(Boolean).join('\n\n')}\n`;
  const combined = plannedImages(design);
  if (combined.length !== originalImages.length + plan.images.length || plan.images.some(({ id, prompt, size, introduction }, index) => {
    const image = combined[originalImages.length + index];
    return image?.id !== id || image.prompt !== prompt.trim() || image.size !== size.trim() || image.introduction !== introduction.trim();
  })) throw new Error('New image fields must contain plain content without Markdown headings.');
  return {
    design, assets: [
      ...source.version.images.map(({ id }): ImageAction => ({ id, source: 1, imageId: id, action: 'reuse' })),
      ...plan.images.map(({ id }): ImageAction => ({ id, action: 'generate' })),
    ],
  };
}

function validatePlans(value: unknown, inventory: Map<string, SourceImage>, count: number, canEditImages: boolean, report?: EditActivityReporter): OutputPlan[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('The plan must contain the requested number of outputs');
  const corrections: string[] = [];
  const plans = value.map((raw, index) => {
    const output = `Output ${index + 1}`;
    if (!raw || typeof raw.design !== 'string' || !Array.isArray(raw.assets)) throw new Error(`${output}: invalid solution output plan.`);
    const markdown: string = raw.design;
    const sections = imageSections(markdown);
    const ids = new Set<string>();
    const submitted = new Map<string, { action?: unknown; sourceRef?: unknown }>();
    for (const asset of raw.assets) {
      if (!asset || typeof asset.id !== 'string') throw new Error(`${output}: every asset action needs an image ID.`);
      if (submitted.has(asset.id)) throw new Error(`${output}: duplicate asset action for "${asset.id}".`);
      submitted.set(asset.id, asset);
    }
    const updates: Array<{ start: number; end: number; text: string }> = [];
    const assets = sections.map((section): ImageAction => {
      const id = section[1]!;
      if (ids.has(id)) throw new Error(`${output}: duplicate image section "${id}".`);
      ids.add(id);
      const asset = submitted.get(id);
      const action = asset?.action;
      const label = `${output}, image "${id}"`;
      if (!asset || (action !== 'reuse' && action !== 'edit' && action !== 'generate')) throw new Error(`${label}: missing or invalid asset action.`);
      if (action !== 'reuse') {
        try { plannedImages(section[0]); }
        catch (error) { throw new Error(`${label} (${action}): ${error instanceof Error ? error.message : 'Invalid image specification'}`); }
      }
      if (action === 'generate') {
        if (asset.sourceRef !== undefined) throw new Error(`${label} (generate): omit sourceRef.`);
        return { id, action };
      }
      if (action === 'edit' && !canEditImages) throw new Error(`${label} (edit): enable image editing in Settings.`);
      const match = typeof asset.sourceRef === 'string' ? inventory.get(asset.sourceRef) : undefined;
      if (!match) {
        const allowed = [...inventory.keys()].slice(0, 12).join(', ');
        throw new Error(`${label} (${action}): unknown sourceRef "${String(asset.sourceRef ?? '(missing)').slice(0, 120)}". Copy an exact reference from the input image inventory (${allowed}${inventory.size > 12 ? ', …' : ''}).`);
      }
      if (action === 'reuse') {
        const body = section[2]!.replace(/^### (Prompt|Size)[^\S\r\n]*\r?\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gm, (_field, name: string, text: string) => {
          const inherited = name === 'Prompt' ? match.image.prompt : match.image.size;
          if (text.trim() !== inherited) corrections.push(`${label} (reuse): inherited ${name} from ${asset.sourceRef}.`);
          return '';
        });
        const headingEnd = section[0].indexOf('\n') + 1;
        updates.push({
          start: section.index!, end: section.index! + section[0].length,
          text: `${section[0].slice(0, headingEnd)}### Prompt\n${match.image.prompt}\n\n### Size\n${match.image.size}\n\n${body}`,
        });
      }
      return { id, action, source: match.source, imageId: match.image.id };
    });
    for (const id of submitted.keys()) if (!ids.has(id)) throw new Error(`${output}: asset action for "${id}" has no image section.`);
    let design = markdown;
    for (const { start, end, text } of updates.reverse()) design = design.slice(0, start) + text + design.slice(end);
    try { plannedImages(design); }
    catch (error) { throw new Error(`${output}: ${error instanceof Error ? error.message : 'Invalid design specification'}`); }
    return { design, assets };
  });
  if (corrections.length) report?.({ actor: 'editor', label: 'Inherited image specifications', state: 'completed', detail: corrections.join('\n') });
  return plans;
}

function replacementPlan(source: Material, id: string, instruction: string): OutputPlan {
  const prompt = instruction.trim();
  if (!prompt || /^\s*#{1,6}\s/mu.test(prompt)) throw new Error('Provide a plain image editing instruction.');
  const section = new RegExp(`^## Image: ${id}[^\\S\\r\\n]*\\r?\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'mu');
  const design = source.design.replace(section, block => block.replace(
    /(^### Prompt[^\S\r\n]*\r?\n)[\s\S]*?(?=^#{1,3} |$(?![\s\S]))/mu, (_, heading: string) => `${heading}${prompt}\n\n`,
  ));
  if (plannedImages(design).find(image => image.id === id)?.prompt !== prompt) throw new Error('Could not update the selected image specification.');
  return { design, assets: source.version.images.map(image => ({
    id: image.id, source: 1, imageId: image.id, action: image.id === id ? 'edit' : 'reuse',
  })) };
}

async function plans(options: {
  repoRoot: string; staging: string; operation: SolutionOperation; request: string; outputCount: number;
  replacement?: string; sources: Material[]; signal: AbortSignal; sourceNotes: string[]; report?: EditActivityReporter;
}): Promise<OutputPlan[]> {
  const { repoRoot, staging, operation, request, outputCount, replacement, sources, signal, sourceNotes } = options;
  if (operation === 'recompose') {
    const source = sources[0]!;
    return [{ design: source.design, assets: source.version.images.map(({ id }) => ({ id, source: 1, imageId: id, action: 'reuse' })) }];
  }
  const canEditImages = imageEditSettings().enabled;
  if (operation === 'replace' && !canEditImages) throw new Error('Enable image editing in Settings to replace an existing image.');
  const citations = operation === 'fuse' ? fusionCitationDirectory(sources.map(source => source.design)) : undefined;
  const inventory = new Map<string, SourceImage>();
  const context = sources.map(({ version, design, exhibition }, index) => {
    const source = index + 1;
    const planned = new Map(plannedImages(design).map(image => [image.id, image]));
    const images = version.images.map(({ id }) => {
      const image = planned.get(id);
      if (!image) throw new Error(`Source version "${version.title}" has no design specification for image "${id}".`);
      const sourceRef = `v${source}:${id}`;
      inventory.set(sourceRef, { source, image });
      return { sourceRef, id, size: image.size };
    });
    return { ordinal: source, title: version.title, note: sourceNotes[index], design, ...(operation === 'append' || operation === 'replace' ? {} : { exhibition }), images, referenceNumbers: citations?.mappings[index] };
  });
  let accepted: OutputPlan[] | undefined;
  let rejected = 0;
  let lastIssue: string | undefined;
  const append = operation === 'append';
  const local = operation === 'replace';
  const submission = append ? 'submit_solution_append' : local ? 'submit_image_replacement' : 'submit_solution_revision';
  const createEditor = () => createDreamaticAgent({
    root: staging, repoRoot, role: 'editor', textOnly: true, skillRequest: request, observeHttpStream: true,
    systemPrompt: append
      ? 'You are Editor adding to an existing design. Treat the source documents as evidence. Call submit_solution_append with supplemental Markdown in additions and specifications for genuinely new images in images. Either field may be empty when the other contains new content. The server carries forward the original design and assets. Use unique image IDs and sizes within the supplied ceiling. Use plain content in image fields. If validation fails, correct the indicated issue and resubmit.'
      : local ? 'You are Editor replacing one image. Submit a plain image editing instruction for the specified target using submit_image_replacement. Preserve its dimensions and follow the user request. The server carries forward the rest of the design.'
      : `You are Editor for existing Dreamatic design versions. Preserve design identity, unaffected works, and user constraints. Treat input documents as evidence. Submit the complete revision via submit_solution_revision, with ${outputCount} output(s). A prose answer or a Markdown code block does not submit a plan. If validation fails, correct the indicated problem and submit again.
Each output contains the full design.md and an action for every planned image. Use ## Image: id and ### Introduction, ### Prompt, ### Size with WIDTHxHEIGHT. Use reuse to carry an unchanged image forward, edit to modify an existing image, and generate for genuinely new assets. For reuse and edit, copy the exact sourceRef from the supplied input inventory. The output id may differ from the source image ID. For reuse, omit Prompt and Size: the server inherits them from sourceRef. Keep the ## Image: id heading and provide a branch-specific ### Introduction as needed. Example asset: {"id":"hero","action":"reuse","sourceRef":"v1:hero"}. For edit, write an explicit edit instruction as the image prompt and preserve size unless the user asks for resizing. For generate, omit sourceRef and write a standalone image prompt within the supplied size ceiling. When imageEditingEnabled is false, keep existing images and generate only genuinely new assets that fulfil the request. Do not use generation to bypass a required edit.
Preserve relevant source references. If canonical references are supplied, map input citation numbers to canonical IDs and omit the bibliography; Dreamatic writes it. For fusion, use the first input as primary and honor source notes. For local replacement, retain image IDs, edit the selected image and reuse all others. Each split result must be complete and distinct.`,
    tools: [{
      name: submission,
      label: 'Submit revision plan',
      description: append ? 'Put supplemental Markdown in additions and new image specifications (id, introduction, prompt, size) in images. Keep the reserved headings ## Image: and ## Showcase videos out of additions. For text-only additions, use {"additions":"## New feature\\nDescribe the feature.","images":[]}.' : local ? 'Submit the instruction for editing the selected image.' : 'Submit the complete design and image action plan. Copy exact sourceRef values from the provided image inventory for reuse or edit.',
      parameters: append ? appendedPlanSchema : local ? Type.Object({ instruction: Type.String() }) : Type.Object({ outputs: Type.Array(Type.Object({
        design: Type.String(),
        assets: Type.Array(Type.Object({
          id: Type.String(), action: Type.Union([Type.Literal('reuse'), Type.Literal('edit'), Type.Literal('generate')]),
          sourceRef: Type.Optional(Type.String()),
        })),
      })) }),
      executionMode: 'sequential',
      async execute(_id, params) {
        signal.throwIfAborted();
        if (accepted) return { content: [{ type: 'text', text: 'The plan has already been accepted.' }], details: {} };
        if (rejected >= 3) throw new Error(lastIssue);
        try {
          const output = append ? [appendPlan(sources[0]!, params as import('typebox').Static<typeof appendedPlanSchema>)]
            : local ? [replacementPlan(sources[0]!, replacement!, (params as { instruction: string }).instruction)]
            : validatePlans((params as { outputs?: unknown } | null)?.outputs, inventory, outputCount, canEditImages, options.report);
          accepted = citations ? output.map(plan => ({ ...plan, design: bindFusionCitations(plan.design, citations.directory) })) : output;
        } catch (error) {
          rejected++;
          lastIssue = error instanceof Error ? error.message : 'Invalid revision plan.';
          options.report?.({ actor: 'editor', label: 'Revision plan validation', state: 'failed', detail: lastIssue });
          throw new Error(lastIssue);
        }
        return { content: [{ type: 'text', text: 'Revision plan accepted. Dreamatic will apply the image actions and build the showcase.' }], details: {}, terminate: true };
      }
    }],
  });
  const input = JSON.stringify({
    operation, request, outputCount, replacement, imageEditingEnabled: canEditImages, generationSizeCeiling: setting('DREAMATIC_IMAGE_DEFAULT_SIZE'),
    ...(citations ? { canonicalReferences: citations.directory } : {}),
    sources: local ? [{ title: sources[0]!.version.title, target: inventory.get(`v1:${replacement}`)?.image }] : context,
  });
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      await promptSolutionModel(await createEditor(), input, signal, 'editor', options.report, {
        shouldStop: () => rejected >= 3,
        retryIf: () => !accepted,
        retryMessage: () => lastIssue
          ? `The plan was not accepted: ${lastIssue} Correct it using ${submission}.`
          : `No plan was submitted. Call ${submission} with the requested fields.`,
      });
      break;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SolutionModelTimeout) {
        if (error.phase !== 'idle' || attempt > 0 || accepted || rejected >= 3) throw error;
        options.report?.({ actor: 'editor', label: 'Retry revision planning', state: 'started', detail: error.message });
        lastIssue = undefined;
      } else {
        if (accepted || !lastIssue) throw error;
        throw new Error(lastIssue, { cause: error });
      }
    }
  }
  if (!accepted) throw new Error(lastIssue ?? 'Editor did not submit a revision plan. Retry the task to request a structured plan.');
  return accepted;
}

async function produceImage(image: ReturnType<typeof plannedImages>[number], source: Buffer | undefined, signal: AbortSignal, report?: EditActivityReporter) {
  const config = imageEditSettings();
  const apiKey = setting('DREAMATIC_IMAGE_API_KEY') || setting('DREAMATIC_API_KEY');
  if (!apiKey) throw new Error('Configure an image API key in Settings');
  if (source && !config.enabled) throw new Error('Image editing is disabled in Settings');
  const kind = source && imageBytesKind(source);
  if (source && !kind) throw new Error('Image editing requires a supported PNG, JPEG or WebP source');
  const [width, height] = dimensions(image.size);
  if (source) {
    const originalSize = imageDimensions(source);
    if (!originalSize) throw new Error('Could not read the source image dimensions');
    const plan = planImageEdit(originalSize, image.prompt, config.size, config.capabilities, { target: { width, height } });
    if (plan.adapted) throw new Error(`The edit provider does not support the planned size for ${image.id}`);
  } else {
    const [maxWidth, maxHeight] = dimensions(setting('DREAMATIC_IMAGE_DEFAULT_SIZE'));
    if (width > maxWidth || height > maxHeight) throw new Error(`Planned image exceeds the configured size budget: ${image.id}`);
    const capability = await imageCapabilityInfo(signal);
    if (capability.verified && !capability.sizes.includes(image.size)) throw new Error(`Unsupported planned image size: ${image.size}`);
  }
  const base = setting('DREAMATIC_IMAGE_BASE_URL').replace(/\/$/u, '');
  const url = source ? setting('DREAMATIC_IMAGE_EDIT_ENDPOINT') || `${base}/images/edits` : setting('DREAMATIC_IMAGE_GENERATION_ENDPOINT') || `${base}/images/generations`;
  const release = await imageSlot(signal);
  try {
    const result = await retryImage(async () => {
      const action = { actor: 'image' as const, label: source ? 'Edit image' : 'Generate image', detail: image.id };
      report?.({ ...action, state: 'started' });
      try {
        const output = await requestImage({
          url, apiKey, model: source ? config.model : setting('DREAMATIC_IMAGE_MODEL'),
          prompt: image.prompt, size: image.size,
          responseFormat: setting(source ? 'DREAMATIC_IMAGE_EDIT_RESPONSE_FORMAT' : 'DREAMATIC_IMAGE_RESPONSE_FORMAT'),
          ...(source ? { images: [{ bytes: source, filename: `source.${kind}`, mimeType: kind === 'jpg' ? 'image/jpeg' : `image/${kind}` }] } : {}),
          timeoutMs: Number(setting('DREAMATIC_IMAGE_TIMEOUT_MS')),
          bodyIdleTimeoutMs: Number(setting('DREAMATIC_IMAGE_BODY_IDLE_TIMEOUT_MS')),
          maxResponseBytes: Number(setting('DREAMATIC_IMAGE_RESPONSE_MAX_BYTES')),
          signal,
        });
        report?.({ ...action, state: 'completed' }, imageActivityUsage(output.usage));
        return output;
      } catch (error) {
        report?.({ ...action, state: 'failed' }, {});
        throw error;
      }
    }, { maxAttempts: Number(setting('DREAMATIC_IMAGE_RETRY_ATTEMPTS')), signal });
    if (!result.ok) throw new Error(`Could not generate ${image.id}: ${result.error.code}`);
    const extension = imageBytesKind(result.value.bytes);
    if (!extension) throw new Error('The image provider returned an invalid image');
    return { bytes: result.value.bytes, extension };
  } finally {
    release();
  }
}

export async function buildSolutionRevision(options: {
  repoRoot: string; workspace: string; staging: string; parents: SolutionVersion[];
  operation: SolutionOperation; request: string; outputCount: number; replacement?: string;
  sourceNotes: string[]; signal: AbortSignal; report?: EditActivityReporter; progress: (phase: string, completed: number, images?: SolutionImageProgress) => Promise<void>;
}): Promise<SolutionDelivery[]> {
  const { repoRoot, workspace, staging, parents, signal, request, progress } = options;
  const read = async (version: SolutionVersion, path: string) => (await readSolutionFile(workspace, version.runId, version.id, path)).bytes;
  const sources = await Promise.all(parents.map(async version => ({
    version,
    design: (await read(version, version.designPath)).toString('utf8'),
    exhibition: version.exhibitionPath ? (await read(version, version.exhibitionPath)).toString('utf8') : '',
  })));
  const outputPlans = await plans({ ...options, sources });
  const imageProgress: SolutionImageProgress = {
    totals: { reuse: 0, edit: 0, generate: 0 },
    completed: { reuse: 0, edit: 0, generate: 0 },
  };
  for (const { assets } of outputPlans) for (const { action } of assets) imageProgress.totals[action]++;
  const deliveries: SolutionDelivery[] = [];
  for (const [index, output] of outputPlans.entries()) {
    await progress('images', index, imageProgress);
    const outputRoot = join(staging, `output-${index + 1}`);
    await mkdir(join(outputRoot, 'artifacts'), { recursive: true });
    const generated: Record<string, GeneratedShowcaseImage> = Object.create(null);
    for (const image of plannedImages(output.design)) {
      signal.throwIfAborted();
      const asset = output.assets.find(entry => entry.id === image.id)!;
      const source = sources[(asset.source ?? 0) - 1]?.version;
      const reference = source?.images.find(entry => entry.id === asset.imageId);
      const original = source && reference ? await read(source, reference.path) : undefined;
      const { bytes, extension } = asset.action === 'reuse'
        ? { bytes: original!, extension: extname(reference!.path).slice(1) }
        : await produceImage(image, asset.action === 'edit' ? original : undefined, signal, options.report);
      if (asset.action === 'reuse') options.report?.({ actor: 'image', label: 'Reuse image', state: 'completed', detail: image.id });
      const digest = createHash('sha256').update(bytes).digest('hex');
      const path = reference && asset.action === 'reuse' && ['recompose', 'append', 'replace'].includes(options.operation)
        ? reference.path : `artifacts/${image.id}-${digest.slice(0, 12)}.${extension}`;
      await writeFile(join(outputRoot, path), bytes);
      generated[image.id] = { path, digest };
      imageProgress.completed[asset.action]++;
      await progress('images', index, imageProgress);
    }
    const videoTitles: Record<string, string> = Object.create(null);
    const carriedVideos = new Set<string>();
    for (const parent of parents) {
      for (const video of parent.videos ?? []) {
        const digest = parent.files[video.path]!;
        if (!['append', 'replace'].includes(options.operation) && carriedVideos.has(digest)) continue;
        carriedVideos.add(digest);
        let id = video.id;
        while (generated[id]) id += '-video';
        const path = ['append', 'replace'].includes(options.operation) ? video.path : `artifacts/${id}-${digest.slice(0, 12)}${extname(video.path)}`;
        const bytes = await read(parent, video.path);
        await writeFile(join(outputRoot, path), bytes);
        generated[id] = { path, digest, kind: 'video' };
        videoTitles[id] = video.title;
      }
    }
    await progress('showcase', index);
    const previousHtml = parents.length === 1 ? await read(parents[0]!, parents[0]!.showcasePath) : undefined;
    if (options.operation === 'replace' && previousHtml && parents[0]!.works && sources[0]!.exhibition) {
      const parent = parents[0]!;
      const old = parent.images.find(image => image.id === options.replacement)!;
      const designText = output.design;
      try {
        const direction = validateShowcaseDirection({
          heroId: parent.heroId, works: parent.works,
          markdown: sources[0]!.exhibition.replace(/^[\s\S]*?All works in narrative order:\n(?:- [^\n]*\n)+\n/u, ''),
        }, Object.keys(generated).map(id => ({ id })), generated);
        const html = previousHtml.toString('utf8').replaceAll(`../${old.path}`, `../${generated[old.id]!.path}`);
        await validateShowcaseHtml(outputRoot, html, direction, generated);
        validateVersionShowcaseResources(html, generated);
        options.report?.({ actor: 'system', label: 'Reuse showcase', state: 'completed' });
        deliveries.push({ designText, html, direction, generated, staging: outputRoot, videoTitles });
        continue;
      } catch {
        options.report?.({ actor: 'system', label: 'Rebuild showcase', state: 'started', detail: 'The previous showcase could not be safely reused.' });
      }
    }
    deliveries.push(await composeSolutionShowcase({
      repoRoot, staging: outputRoot, signal, request, ...(options.report ? { report: options.report } : {}),
      designText: ['recompose', 'append'].includes(options.operation) ? output.design : includeVersionVideos(output.design, videoTitles),
      generated, videoTitles,
      compactContext: options.operation === 'replace',
      ...(options.operation === 'append' ? { materialChanges: { kind: 'added' as const, ids: output.assets.filter(asset => asset.action === 'generate').map(asset => asset.id) } } : {}),
      previousExhibition: sources.map(({ exhibition }, ordinal) => `Source ${ordinal + 1}:\n${exhibition}`).join('\n\n'),
      ...(previousHtml ? { previousHtml } : {}),
    }));
  }
  return deliveries;
}
