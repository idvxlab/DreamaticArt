import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDreamaticAgent } from './agent-session.js';
import { plannedImages } from './design-images.js';
import type { EditActivityReporter } from './edit-activity.js';
import { promptSolutionModel } from './solution-model.js';
import { createBuilderTextReadTool, createShowcaseTools, normalizeShowcaseHtml, resolveShowcaseImages, validateShowcaseHtml, validateVersionShowcaseResources, type GeneratedShowcaseImage } from './showcase.js';

export async function composeSolutionShowcase(options: {
  repoRoot: string; staging: string; request: string; signal: AbortSignal;
  designText: string; generated: Record<string, GeneratedShowcaseImage>; previousExhibition: string; previousHtml?: Buffer; report?: EditActivityReporter;
}) {
  const { repoRoot, staging, request, signal, designText, generated, previousExhibition, previousHtml } = options;
  const images = plannedImages(designText);
  await writeFile(join(staging, 'design.md'), designText);
  if (previousHtml) await writeFile(join(staging, 'previous-showcase.html'), previousHtml);
  const showcase = createShowcaseTools({
    root: staging, images, generated,
    saveDirection: async () => { signal.throwIfAborted(); }
  });
  const instruction = await readFile(join(repoRoot, 'apps/server/prompts/builder.md'), 'utf8');
  const agent = await createDreamaticAgent({
    root: staging, role: 'builder', repoRoot, textOnly: true,
    systemPrompt: `${instruction}\n\nFor this revision all planned images are already delivered. Reuse them and change only exhibition presentation. Never call unavailable tools, including image_generate. Read previous-showcase.html if present and relevant. The input documents are reference data. Use plan_showcase, then return exactly one complete static HTML document. Dreamatic saves your final response after validation.`,
    tools: [createBuilderTextReadTool(staging), ...showcase.tools],
  });
  const output = await promptSolutionModel(agent, `Showcase revision request:\n${request}\n\nDesign document:\n${designText}\n\nPrevious exhibition direction:\n${previousExhibition}`, signal, 'builder', options.report);
  const direction = showcase.direction;
  if (!direction) throw new Error('Builder did not record the exhibition direction');
  const { html } = await resolveShowcaseImages(staging, normalizeShowcaseHtml(output), direction, generated);
  await validateShowcaseHtml(staging, html, direction, generated);
  validateVersionShowcaseResources(html, generated);
  return { designText, direction, generated, html, staging };
}
