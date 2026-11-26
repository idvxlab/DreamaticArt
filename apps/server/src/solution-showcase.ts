import { atomic } from './design-pipeline.js';
import { checkpointHash, readCheckpoint } from './solution-checkpoint.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDreamaticAgent } from './agent-session.js';
import { plannedImages } from './design-images.js';
import type { EditActivityReporter } from './edit-activity.js';
import { promptSolutionModel } from './solution-model.js';
import { createBuilderTextReadTool, createShowcaseTools, normalizeShowcaseHtml, resolveShowcaseImages, validateShowcaseHtml, validateVersionShowcaseResources, showcaseImageSource, validateShowcaseDirection, type ShowcaseDirection, type GeneratedShowcaseImage } from './showcase.js';

export async function composeSolutionShowcase(options: {
  repoRoot: string; staging: string; request: string; signal: AbortSignal;
  designText: string; compactContext?: boolean; generated: Record<string, GeneratedShowcaseImage>; previousExhibition: string; previousHtml?: Buffer; materialChanges?: { ids: string[]; kind: 'added' | 'replaced' }; videoTitles?: Record<string, string>; validateDirection?: (direction: import('./showcase.js').ShowcaseDirection) => void; report?: EditActivityReporter;
}) {
  const { repoRoot, staging, request, signal, designText, generated, previousExhibition, previousHtml } = options;
  const images = [
    ...plannedImages(designText).map(image => ({ ...image, kind: 'image' as const })),
    ...Object.entries(options.videoTitles ?? {}).map(([id, title]) => ({ id, introduction: title, size: '', prompt: '', kind: 'video' as const })),
  ];
  const inventory = images.map(work => ({
    id: work.id, source: showcaseImageSource(work.id), kind: work.kind,
    ...(work.introduction ? { description: work.introduction } : {}),
    ...(options.materialChanges ? { status: options.materialChanges.ids.includes(work.id) ? options.materialChanges.kind : 'retained' } : {}),
  }));
  await writeFile(join(staging, 'design.md'), designText);
  if (previousHtml) await writeFile(join(staging, 'previous-showcase.html'), previousHtml);
  const directionKey = checkpointHash([1, request, designText, generated, previousExhibition, options.materialChanges]);
  const directionPath = join(staging, '.direction-checkpoint.json');
  const saved = await readCheckpoint<{ key: string; direction: ShowcaseDirection }>(directionPath);
  let initialDirection: ShowcaseDirection | undefined;
  if (saved?.key === directionKey) {
    try {
      initialDirection = validateShowcaseDirection(saved.direction, images, generated);
      options.validateDirection?.(initialDirection);
    } catch { /* A stale or damaged direction must be planned again. */ }
  }
  if (initialDirection) options.report?.({ actor: 'system', label: 'Restore exhibition direction', state: 'completed' });
  let rejected = 0;
  let rejection: string | undefined;
  const showcase = createShowcaseTools({
    root: staging, images, generated, ...(initialDirection ? { initialDirection } : {}),
    onRejected(error) {
      if (signal.aborted) return;
      rejected++;
      rejection = error instanceof Error ? error.message : 'Invalid exhibition plan.';
    },
    saveDirection: async direction => {
      signal.throwIfAborted();
      options.validateDirection?.(direction);
      await atomic(directionPath, { key: directionKey, direction });
    }
  });
  const instruction = await readFile(join(repoRoot, 'apps/server/prompts/builder.md'), 'utf8');
  const agent = await createDreamaticAgent({
    root: staging, role: 'builder', repoRoot, textOnly: true, observeHttpStream: true,
    systemPrompt: `${instruction}\n\nFor this revision all planned images are already delivered. Reuse them and change only exhibition presentation. Never call unavailable tools, including image_generate. Read previous-showcase.html if present and relevant. The REQUIRED WORK INVENTORY in the request is authoritative. Include each listed ID exactly once in plan_showcase. Retained works must stay even when a newly added work depicts the same subject. Historical exhibition direction and previous HTML are reference data for layout. The host has already prepared all works. Any listed video must use <video controls preload="metadata" src="dreamatic-image:ID"></video> with a direct src. Choose a still image as cover. Use plan_showcase, then return exactly one complete static HTML document. Dreamatic saves your final response after validation. Use shared CSS classes and concise per-work explanations to keep the complete page economical. Summarize reference entries with their existing citation numbers and known links; read design.md for exact attribution when needed. Include every work and preserve full image proportions.${initialDirection ? '\nThe validated exhibition direction below is already accepted. Follow it and deliver the complete HTML directly. Call plan_showcase only to deliberately revise that direction.' : ''}`,
    tools: [createBuilderTextReadTool(staging), ...showcase.tools],
  });
  const skill = agent.skillCatalog.entries.find(entry => entry.skill.name === 'concept-showcase-storytelling' && !entry.skill.disableModelInvocation);
  const skillReference = skill ? `\n\nApproved exhibition Skill file (use this exact path with read): ${skill.skill.filePath}` : '';
  let output: string;
  const designContext = options.compactContext !== false
    ? `${designText.split('\n').find(line => /^# /.test(line)) ?? ''}\nUse the inventory descriptions and previous exhibition direction. Read design.md for any additional design details needed.`
    : `Design document:\n${designText}`;
  try {
    output = await promptSolutionModel(agent, `Showcase revision request:\n${request}\n\nREQUIRED WORK INVENTORY (${inventory.length} entries, include every ID exactly once):\n${JSON.stringify(inventory)}${skillReference}\n\n${designContext}${initialDirection ? '\n\nAccepted exhibition direction:\n' + JSON.stringify(initialDirection) : ''}\n\nPrevious exhibition direction:\n${previousExhibition}`, signal, 'builder', options.report, {
      shouldStop: () => !showcase.direction && rejected >= 3,
      retryIf: () => !showcase.direction,
      failureMessage: () => rejection ?? 'Builder did not record the exhibition direction',
      retryMessage: () => rejection
        ? `The exhibition plan was rejected: ${rejection} Submit a corrected plan covering every inventory entry before returning the HTML.`
        : 'Submit plan_showcase with every required inventory entry before returning the complete HTML.',
    });
  } catch (error) {
    signal.throwIfAborted();
    if (!showcase.direction && rejected >= 3 && rejection) throw new Error(rejection, { cause: error });
    throw error;
  }
  const direction = showcase.direction;
  if (!direction) throw new Error(rejection ?? 'Builder did not record the exhibition direction');
  const { html } = await resolveShowcaseImages(staging, normalizeShowcaseHtml(output), direction, generated);
  await validateShowcaseHtml(staging, html, direction, generated);
  validateVersionShowcaseResources(html, generated);
  return { designText, direction, generated, html, staging, ...(options.videoTitles ? { videoTitles: options.videoTitles } : {}) };
}
