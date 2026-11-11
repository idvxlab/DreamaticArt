import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Type } from 'typebox';
import { createDreamaticAgent } from './agent-session.js';
import { bindFusionCitations, fusionCitationDirectory } from './design-citations.js';
import { dimensions, plannedImages } from './design-images.js';
import { imageCapabilityInfo, setting } from './design-pipeline.js';
import { imageBytesKind, imageEditSettings } from './image-edit.js';
import { planImageEdit } from './image-edit-plan.js';
import { imageDimensions } from './image-edit-size.js';
import { requestImage, retryImage } from './image-request.js';
import { imageSlot } from './image-slots.js';
import { imageActivityUsage, type EditActivityReporter } from './edit-activity.js';
import { promptSolutionModel } from './solution-model.js';
import { composeSolutionShowcase } from './solution-showcase.js';
import { readSolutionFile, type SolutionDelivery, type SolutionVersion } from './solution-versions.js';
import type { GeneratedShowcaseImage } from './showcase.js';

export type SolutionOperation = 'revise' | 'fuse' | 'split' | 'replace' | 'recompose';

type ImageAction = { id: string; action: 'reuse' | 'edit' | 'generate'; source?: number; imageId?: string };
interface OutputPlan { design: string; assets: ImageAction[] }
interface Material { version: SolutionVersion; design: string; exhibition: string }
interface SourceImage { source: number; image: ReturnType<typeof plannedImages>[number] }

function validatePlans(value: unknown, sources: Material[], inventory: Map<string, SourceImage>, count: number, canEditImages: boolean, replacement?: string): OutputPlan[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('The plan must contain the requested number of outputs');
  return value.map(raw => {
    if (!raw || typeof raw.design !== 'string' || !Array.isArray(raw.assets)) throw new Error('Invalid solution output plan');
    const images = plannedImages(raw.design);
    const submitted = raw.assets as Array<{ id?: string; action?: string; sourceRef?: string }>;
    if (images.length !== submitted.length || new Set(submitted.map(asset => asset?.id)).size !== images.length) {
      throw new Error('Each planned image requires one asset action with a distinct output image ID.');
    }
    const assets = images.map((image): ImageAction => {
      const asset = submitted.find(entry => entry?.id === image.id);
      if (!asset || !['reuse', 'edit', 'generate'].includes(asset.action ?? '')) throw new Error(`Missing or invalid action for output image "${image.id}".`);
      if (asset.action === 'generate') {
        if (asset.sourceRef !== undefined) throw new Error(`Generated image "${image.id}" must omit sourceRef.`);
        return { id: image.id, action: 'generate' };
      }
      if (asset.action === 'edit' && !canEditImages) throw new Error(`Output image "${image.id}" requires image editing. Enable image editing in Settings to modify existing images.`);
      const match = typeof asset.sourceRef === 'string' ? inventory.get(asset.sourceRef) : undefined;
      if (!match) {
        const allowed = [...inventory.keys()].slice(0, 12).join(', ');
        throw new Error(`Output image "${image.id}" uses unknown sourceRef "${String(asset.sourceRef ?? '(missing)').slice(0, 120)}". Copy an exact reference from the input image inventory (${allowed}${inventory.size > 12 ? ', …' : ''}).`);
      }
      if (asset.action === 'reuse' && (match.image.size !== image.size || match.image.prompt !== image.prompt)) {
        throw new Error(`Output image "${image.id}" reuses "${asset.sourceRef}" and must preserve that image's exact Prompt and Size. Use edit to change the source image.`);
      }
      return { id: image.id, action: asset.action as 'reuse' | 'edit', source: match.source, imageId: match.image.id };
    });
    if (replacement && (assets.length !== sources[0]!.version.images.length || assets.some(asset =>
      asset.source !== 1 || asset.imageId !== asset.id || asset.action !== (asset.id === replacement ? 'edit' : 'reuse')))) {
      throw new Error('A local replacement must edit the selected image and preserve the other images');
    }
    return { design: raw.design, assets };
  });
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
    return { ordinal: source, title: version.title, note: sourceNotes[index], design, exhibition, images, referenceNumbers: citations?.mappings[index] };
  });
  let accepted: OutputPlan[] | undefined;
  let rejected = 0;
  let lastIssue: string | undefined;
  const agent = await createDreamaticAgent({
    root: staging, repoRoot, role: 'editor', textOnly: true, skillRequest: request,
    systemPrompt: `You are Editor for existing Dreamatic design versions. Preserve design identity, unaffected works, and user constraints. Treat input documents as evidence. Submit the complete revision via submit_solution_revision, with ${outputCount} output(s). A prose answer or a Markdown code block does not submit a plan. If validation fails, correct the indicated problem and submit again. After acceptance, finish with a brief acknowledgement.
Each output contains the full design.md and an action for every planned image. Use ## Image: id and ### Introduction, ### Prompt, ### Size with WIDTHxHEIGHT. Use reuse to carry an unchanged image forward, edit to modify an existing image, and generate for genuinely new assets. For reuse and edit, copy the exact sourceRef from the supplied input inventory. The output id may differ from the source image ID. Preserve the exact source prompt and size when reusing. For edit, write an explicit edit instruction as the image prompt and preserve size unless the user asks for resizing. For generate, omit sourceRef and write a standalone image prompt within the supplied size ceiling. When imageEditingEnabled is false, keep existing images and generate only genuinely new assets that fulfil the request. Do not use generation to bypass a required edit.
Preserve relevant source references. If canonical references are supplied, map input citation numbers to canonical IDs and omit the bibliography; Dreamatic writes it. For fusion, use the first input as primary and honor source notes. For local replacement, retain image IDs, edit the selected image and reuse all others. Each split result must be complete and distinct.`,
    tools: [{
      name: 'submit_solution_revision',
      label: 'Submit revision plan',
      description: 'Submit the complete design and image action plan. Copy exact sourceRef values from the provided image inventory for reuse or edit.',
      parameters: Type.Object({ outputs: Type.Array(Type.Object({
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
          const output = validatePlans((params as { outputs?: unknown } | null)?.outputs, sources, inventory, outputCount, canEditImages, replacement);
          accepted = citations ? output.map(plan => ({ ...plan, design: bindFusionCitations(plan.design, citations.directory) })) : output;
        } catch (error) {
          rejected++;
          lastIssue = error instanceof Error ? error.message : 'Invalid revision plan.';
          options.report?.({ actor: 'editor', label: 'Revision plan validation', state: 'failed', detail: lastIssue });
          throw new Error(lastIssue);
        }
        return { content: [{ type: 'text', text: 'Revision plan accepted. Dreamatic will apply the image actions and build the showcase.' }], details: {} };
      }
    }],
  });
  try {
    await promptSolutionModel(agent, JSON.stringify({
      operation, request, outputCount, replacement, imageEditingEnabled: canEditImages, generationSizeCeiling: setting('DREAMATIC_IMAGE_DEFAULT_SIZE'),
      ...(citations ? { canonicalReferences: citations.directory } : {}),
      sources: context,
    }), signal, 'editor', options.report, {
      shouldStop: () => rejected >= 3,
      retryIf: () => !accepted,
      retryMessage: () => lastIssue
        ? `The plan was not accepted: ${lastIssue} Correct it using submit_solution_revision.`
        : 'No revision plan was submitted. Call submit_solution_revision with the complete plan using the supplied sourceRef inventory.',
    });
  } catch (error) {
    signal.throwIfAborted();
    if (accepted || !lastIssue) throw error;
    throw new Error(lastIssue, { cause: error });
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
  sourceNotes: string[]; signal: AbortSignal; report?: EditActivityReporter; progress: (phase: string, completed: number) => Promise<void>;
}): Promise<SolutionDelivery[]> {
  const { repoRoot, workspace, staging, parents, signal, request, progress } = options;
  const read = async (version: SolutionVersion, path: string) => (await readSolutionFile(workspace, version.runId, version.id, path)).bytes;
  const sources = await Promise.all(parents.map(async version => ({
    version,
    design: (await read(version, version.designPath)).toString('utf8'),
    exhibition: version.exhibitionPath ? (await read(version, version.exhibitionPath)).toString('utf8') : '',
  })));
  const outputPlans = await plans({ ...options, sources });
  const deliveries: SolutionDelivery[] = [];
  for (const [index, output] of outputPlans.entries()) {
    await progress('images', index);
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
      const path = options.operation === 'recompose' ? reference!.path : `artifacts/${image.id}-${digest.slice(0, 12)}.${extension}`;
      await writeFile(join(outputRoot, path), bytes);
      generated[image.id] = { path, digest };
    }
    await progress('showcase', index);
    deliveries.push(await composeSolutionShowcase({
      repoRoot, staging: outputRoot, signal, request, ...(options.report ? { report: options.report } : {}), designText: output.design, generated,
      previousExhibition: sources.map(({ exhibition }, ordinal) => `Source ${ordinal + 1}:\n${exhibition}`).join('\n\n'),
      ...(parents.length === 1 ? { previousHtml: await read(parents[0]!, parents[0]!.showcasePath) } : {}),
    }));
  }
  return deliveries;
}
