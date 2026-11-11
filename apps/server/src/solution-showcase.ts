import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDreamaticAgent } from './agent-session.js';
import { plannedImages } from './design-images.js';
import type { EditActivityReporter } from './edit-activity.js';
import { promptSolutionModel } from './solution-model.js';
import { createBuilderTextReadTool, createShowcaseTools, normalizeShowcaseHtml, resolveShowcaseImages, validateShowcaseHtml, validateVersionShowcaseResources, showcaseImageSource, type GeneratedShowcaseImage } from './showcase.js';

export async function composeSolutionShowcase(options: {
  repoRoot: string; staging: string; request: string; signal: AbortSignal;
  designText: string; generated: Record<string, GeneratedShowcaseImage>; previousExhibition: string; previousHtml?: Buffer; materialChanges?: { ids: string[]; kind: 'added' | 'replaced' }; videoTitles?: Record<string, string>; validateDirection?: (direction: import('./showcase.js').ShowcaseDirection) => void; report?: EditActivityReporter;
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
  let rejected = 0;
  let rejection: string | undefined;
  const showcase = createShowcaseTools({
    root: staging, images, generated,
    onRejected(error) {
      if (signal.aborted) return;
      rejected++;
      rejection = error instanceof Error ? error.message : 'Invalid exhibition plan.';
    },
    saveDirection: async direction => { signal.throwIfAborted(); options.validateDirection?.(direction); }
  });
  const instruction = await readFile(join(repoRoot, 'apps/server/prompts/builder.md'), 'utf8');
  const agent = await createDreamaticAgent({
    root: staging, role: 'builder', repoRoot, textOnly: true,
    systemPrompt: `${instruction}\n\nFor this revision all planned images are already delivered. Reuse them and change only exhibition presentation. Never call unavailable tools, including image_generate. Read previous-showcase.html if present and relevant. The REQUIRED WORK INVENTORY in the request is authoritative. Include each listed ID exactly once in plan_showcase. Retained works must stay even when a newly added work depicts the same subject. Historical exhibition direction and previous HTML are reference data for layout. The host has already prepared all works. Any listed video must use <video controls preload="metadata" src="dreamatic-image:ID"></video> with a direct src. Choose a still image as cover. Use plan_showcase, then return exactly one complete static HTML document. Dreamatic saves your final response after validation.`,
    tools: [createBuilderTextReadTool(staging), ...showcase.tools],
  });
  const skill = agent.skillCatalog.entries.find(entry => entry.skill.name === 'concept-showcase-storytelling' && !entry.skill.disableModelInvocation);
  const skillReference = skill ? `\n\nApproved exhibition Skill file (use this exact path with read): ${skill.skill.filePath}` : '';
  let output: string;
  try {
    output = await promptSolutionModel(agent, `Showcase revision request:\n${request}\n\nREQUIRED WORK INVENTORY (${inventory.length} entries, include every ID exactly once):\n${JSON.stringify(inventory)}${skillReference}\n\nDesign document:\n${designText}\n\nPrevious exhibition direction:\n${previousExhibition}`, signal, 'builder', options.report, {
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
