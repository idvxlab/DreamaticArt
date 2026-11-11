import type { EditAttempt } from '@dreamatic/project-data';
import { editActivityLog } from './edit-activity.js';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomic } from './design-pipeline.js';
import { buildSolutionRevision, type SolutionOperation } from './solution-revision.js';
import { findSolutionVersion, publishSolutionBatch, solutionProjectDirectory } from './solution-versions.js';

interface SolutionTaskInput {
  id: string;
  parentIds: string[];
  sourceNotes: string[];
  outputCount: number;
  replacement?: string;
  promptNodeId?: string;
  prompt: string;
  originalPrompt?: string;
  operation: SolutionOperation;
}

interface SolutionTask extends SolutionTaskInput {
  outputId: string;
  outputIds: string[];
  activity?: EditAttempt[];
  phase?: string;
  completed?: number;
  createdAt: string;
  attempt: number;
  status: 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error?: string;
}

const taskId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u;
const parentId = /^[a-f0-9]{64}$/u;
const active = new Map<string, { controller: AbortController; ready: Promise<SolutionTask>; completion: { done?: Promise<void> } }>();
const shutdownReason = Symbol('solution task shutdown');

const projectSlots = new Map<string, Set<() => void>>();

async function acquireProjectSlot(directory: string, signal: AbortSignal) {
  while (projectSlots.has(directory)) {
    signal.throwIfAborted();
    const waiters = projectSlots.get(directory)!;
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { waiters.delete(wake); reject(signal.reason); };
      waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  signal.throwIfAborted();
  const waiters = new Set<() => void>();
  projectSlots.set(directory, waiters);
  return () => {
    projectSlots.delete(directory);
    for (const wake of waiters) wake();
  };
}

export const solutionTasksInProgress = () => active.size > 0;

export async function projectSolutionTasksInProgress(workspace: string, runId: string) {
  if (!active.size) return false;
  const directory = join(await solutionProjectDirectory(workspace, runId), 'solution-tasks');
  return [...active.keys()].some(path => dirname(path) === directory);
}

export async function stopSolutionTasks() {
  const running = [...active.values()];
  for (const task of running) task.controller.abort(shutdownReason);
  await Promise.allSettled(running.map(async task => {
    await task.ready;
    await task.completion.done;
  }));
}

async function taskDirectory(workspace: string, runId: string) {
  const directory = join(await solutionProjectDirectory(workspace, runId), 'solution-tasks');
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('Invalid solution task directory');
  return directory;
}

async function readTask(path: string): Promise<SolutionTask | undefined> {
  try {
    if (await realpath(path) !== path) throw new Error('Invalid solution task path');
    const task = JSON.parse(await readFile(path, 'utf8'));
    return { ...task, parentIds: task.parentIds ?? [task.parentId], outputIds: task.outputIds ?? [task.outputId], outputCount: task.outputCount ?? 1, sourceNotes: task.sourceNotes ?? [''] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function taskStatus(workspace: string, runId: string, path: string, task: SolutionTask, running = active.has(path)): Promise<SolutionTask> {
  const outputs = await Promise.all(task.outputIds.map(id => findSolutionVersion(workspace, runId, id)));
  // The atomic version commit is authoritative after a restart.
  if (outputs.every(output => output?.taskId === task.id)) return { ...task, status: 'succeeded' };
  if (running) return task.status === 'waiting' ? task : { ...task, status: 'running' };
  if (task.status === 'running' || task.status === 'waiting') return { ...task, status: 'interrupted' };
  return task;
}

export async function listSolutionTasks(workspace: string, runId: string) {
  const directory = await taskDirectory(workspace, runId);
  const entries = await readdir(directory, { withFileTypes: true });
  const tasks = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && taskId.test(entry.name.slice(0, -5))).map(async entry => {
    const path = join(directory, entry.name);
    const task = await readTask(path);
    return task && taskStatus(workspace, runId, path, task);
  }));
  return tasks.filter(task => task !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function submitSolutionTask(repoRoot: string, workspace: string, runId: string, input: Record<string, unknown>) {
  const { id, operation, prompt, replacement, promptNodeId, originalPrompt } = input;
  const parents = input.parentIds ?? [input.parentId];
  const count = input.outputCount ?? (operation === 'split' ? 2 : 1);
  const notes = input.sourceNotes ?? (Array.isArray(parents) ? parents.map(() => '') : []);
  if (typeof id !== 'string' || !taskId.test(id) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000 ||
      !Array.isArray(parents) || parents.length < (operation === 'fuse' ? 2 : 1) || parents.length > (operation === 'fuse' ? 8 : 1) ||
      parents.some(parent => typeof parent !== 'string' || !parentId.test(parent)) || new Set(parents).size !== parents.length ||
      !Array.isArray(notes) || notes.length !== parents.length || notes.some(note => typeof note !== 'string' || note.length > 1000) ||
      (originalPrompt !== undefined && (typeof originalPrompt !== 'string' || originalPrompt.length > 16000)) ||
      !Number.isInteger(count) || (operation === 'split' ? Number(count) < 2 || Number(count) > 4 : count !== 1) ||
      (operation === 'replace' && (typeof replacement !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(replacement))) ||
      (promptNodeId !== undefined && (typeof promptNodeId !== 'string' || !taskId.test(promptNodeId))) ||
      !['recompose', 'revise', 'fuse', 'split', 'replace'].includes(String(operation))) {
    throw new Error('Invalid solution task inputs');
  }
  return start(repoRoot, workspace, runId, {
    id, parentIds: parents, sourceNotes: notes, prompt: prompt.trim(), ...(typeof originalPrompt === 'string' ? { originalPrompt } : {}), operation: operation as SolutionOperation,
    outputCount: Number(count), ...(typeof replacement === 'string' ? { replacement } : {}),
    ...(typeof promptNodeId === 'string' ? { promptNodeId } : {}),
  }, false);
}

export async function solutionTaskAction(repoRoot: string, workspace: string, runId: string, id: string, action: 'cancel' | 'retry') {
  if (!taskId.test(id)) throw new Error('Invalid solution task ID');
  const path = join(await taskDirectory(workspace, runId), id + '.json');
  if (action === 'cancel') {
    const running = active.get(path);
    if (running) {
      const task = await running.ready;
      running.controller.abort();
      return task;
    }
  }
  const task = await readTask(path);
  if (!task) throw new Error('Solution task not found');
  if (action === 'retry') return start(repoRoot, workspace, runId, task, true);
  return taskStatus(workspace, runId, path, task);
}

async function start(repoRoot: string, workspace: string, runId: string, input: SolutionTaskInput, retry: boolean) {
  const directory = await taskDirectory(workspace, runId);
  const path = join(directory, input.id + '.json');
  const verify = (task: SolutionTask) => {
    if (JSON.stringify(task.parentIds) !== JSON.stringify(input.parentIds) || JSON.stringify(task.sourceNotes) !== JSON.stringify(input.sourceNotes) || task.prompt !== input.prompt || task.originalPrompt !== input.originalPrompt || task.operation !== input.operation || task.outputCount !== input.outputCount || task.replacement !== input.replacement || task.promptNodeId !== input.promptNodeId) {
      throw new Error('Solution task ID already has different inputs');
    }
    return task;
  };
  const current = active.get(path);
  if (current) return verify(await current.ready);
  const controller = new AbortController();
  const completion: { done?: Promise<void> } = {};
  const ready = (async (): Promise<SolutionTask> => {
    const saved = await readTask(path);
    if (saved) {
      const previous = verify(await taskStatus(workspace, runId, path, saved, false));
      if (!retry || previous.status === 'succeeded') {
        active.delete(path);
        return previous;
      }
    }
    const sources = await Promise.all(input.parentIds.map(id => findSolutionVersion(workspace, runId, id)));
    const parents = sources.filter(source => source !== undefined);
    if (parents.length !== input.parentIds.length) throw new Error('Source version not found in this project');
    if (input.replacement && !parents[0]?.images.some(image => image.id === input.replacement)) throw new Error('Replacement image is missing');
    const batch = createHash('sha256').update(JSON.stringify(['solution-task', runId, input.id])).digest('hex').slice(0, 62);
    const outputIds = saved?.outputIds ?? Array.from({ length: input.outputCount }, (_, index) => batch + String(index).padStart(2, '0'));
    const attempt = (saved?.attempt ?? 0) + 1;
    const activity = editActivityLog(attempt, () => { const value = structuredClone(task); return () => atomic(path, value); });
    const task: SolutionTask = {
      id: input.id, parentIds: input.parentIds, sourceNotes: input.sourceNotes, prompt: input.prompt,
      operation: input.operation, outputCount: input.outputCount, ...(input.originalPrompt ? { originalPrompt: input.originalPrompt } : {}),
      ...(input.replacement ? { replacement: input.replacement } : {}),
      ...(input.promptNodeId ? { promptNodeId: input.promptNodeId } : {}),
      createdAt: saved?.createdAt ?? new Date().toISOString(), attempt, activity: [...(saved?.activity ?? []), activity.attempt],
      outputId: outputIds[0]!, outputIds, phase: 'planning', completed: 0, status: 'waiting'
    };
    await atomic(path, task);
    completion.done = execute().catch(error => console.error('Could not persist solution task result', error));
    return structuredClone(task);

    async function execute() {
      const signal = controller.signal;
      let staging: string | undefined;
      let release: (() => void) | undefined;
      try {
        release = await acquireProjectSlot(directory, signal);
        signal.throwIfAborted();
        task.status = 'running';
        await activity.start();
        staging = await mkdtemp(join(directory, '.build-'));
        const deliveries = await buildSolutionRevision({
          repoRoot, workspace, parents, staging, signal, request: task.prompt, outputCount: task.outputCount,
          report: activity.report, operation: task.operation, sourceNotes: task.sourceNotes, ...(task.replacement ? { replacement: task.replacement } : {}),
          progress: async (phase, completed) => { signal.throwIfAborted(); task.phase = phase; task.completed = completed; await activity.write(); }
        });
        activity.report({ actor: 'system', label: 'Publish versions', state: 'started' });
        await publishSolutionBatch({ workspace, runId, parents, taskId: task.id, outputIds: task.outputIds, deliveries, signal });
        activity.report({ actor: 'system', label: 'Publish versions', state: 'completed' });
        task.status = 'succeeded';
        await activity.finish('succeeded');
      } catch (error) {
        const status = signal.reason === shutdownReason ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed';
        if (task.status === 'succeeded') throw error;
        task.status = status;
        if (status === 'failed') task.error = error instanceof Error ? error.message : 'Solution generation failed';
        await activity.finish(status);
        return;
      } finally {
        try {
          if (staging) await rm(staging, { recursive: true, force: true });
        } finally {
          active.delete(path);
          release?.();
        }
      }
    }
  })().catch(error => {
    active.delete(path);
    throw error;
  });
  active.set(path, { controller, ready, completion });
  return ready;
}
