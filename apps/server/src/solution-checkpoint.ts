import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { atomic } from './design-pipeline.js';
import { validateShowcaseDirection, validateShowcaseHtml, validateVersionShowcaseResources, type GeneratedShowcaseImage } from './showcase.js';
import type { SolutionDelivery } from './solution-versions.js';

export const checkpointHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function readCheckpoint<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function validCheckpointImage(root: string, image?: GeneratedShowcaseImage) {
  if (!image || !/^artifacts\/(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_./-]+$/.test(image.path)) return false;
  try {
    const base = await realpath(root);
    const path = await realpath(join(root, image.path));
    if (!path.startsWith(base + sep)) return false;
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex') === image.digest;
  } catch { return false; }
}

export async function restoreShowcase(root: string, key: string, generated: Record<string, GeneratedShowcaseImage>) {
  const saved = await readCheckpoint<{ key: string; digest: string; delivery: SolutionDelivery }>(join(root, '.showcase-checkpoint.json'));
  if (!saved || saved.key !== key || saved.digest !== checkpointHash(saved.delivery)) return;
  try {
    const delivery = saved.delivery;
    if (checkpointHash(delivery.generated) !== checkpointHash(generated)) return;
    for (const image of Object.values(generated)) if (!await validCheckpointImage(root, image)) return;
    const direction = validateShowcaseDirection(delivery.direction, Object.keys(generated).map(id => ({ id })), generated);
    await validateShowcaseHtml(root, delivery.html, direction, generated);
    validateVersionShowcaseResources(delivery.html, generated);
    return { ...delivery, staging: root, generated, direction };
  } catch { return; }
}

export async function saveShowcase(key: string, delivery: SolutionDelivery) {
  await atomic(join(delivery.staging, '.showcase-checkpoint.json'), { key, digest: checkpointHash(delivery), delivery });
}
