import type { createDreamaticAgent } from './agent-session.js';
import { modelActivityUsage, type EditActivityReporter } from './edit-activity.js';
import { setting } from './design-pipeline.js';
import { createModelResponseTimer } from './model-response-timer.js';

export async function promptSolutionModel(agent: Awaited<ReturnType<typeof createDreamaticAgent>>, text: string, signal: AbortSignal, role: 'editor' | 'builder', report?: EditActivityReporter, recovery?: { shouldStop: () => boolean; retryIf: () => boolean; retryMessage: () => string }) {
  const { session, prompt } = agent;
  const abort = () => { void session.abort(); };
  const timer = createModelResponseTimer({
    firstOutputMs: Number(setting(`DREAMATIC_MODEL_TURN_TIMEOUT_MS_${role.toUpperCase()}`) || setting('DREAMATIC_MODEL_TURN_TIMEOUT_MS')),
    generationMs: Number(setting('DREAMATIC_MODEL_GENERATION_TIMEOUT_MS')),
    idleMs: Number(setting('DREAMATIC_MODEL_IDLE_TIMEOUT_MS')),
    totalMs: Number(setting('DREAMATIC_MODEL_TOTAL_TIMEOUT_MS')),
    onTimeout: abort,
  });
  report?.({ actor: role, label: 'Agent execution', state: 'started' });
  const unsubscribe = session.subscribe(event => {
    timer.handle(event);
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const failed = event.message.stopReason === 'error' || event.message.stopReason === 'aborted';
      report?.({ actor: role, label: 'Model response', state: failed ? 'failed' : 'completed' }, modelActivityUsage(event.message.usage));
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      report?.({ actor: role, label: event.toolName, state: event.type === 'tool_execution_start' ? 'started' : event.isError ? 'failed' : 'completed' });
      if (event.type === 'tool_execution_end' && recovery?.shouldStop()) abort();
    }
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await prompt(text);
    signal.throwIfAborted();
    if (timer.failure) throw new Error(`Model response timeout (${timer.failure})`);
    if (recovery?.retryIf() && !recovery.shouldStop() && !session.messages.some(message => message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason))) {
      await prompt(recovery.retryMessage());
      signal.throwIfAborted();
      if (timer.failure) throw new Error(`Model response timeout (${timer.failure})`);
    }
    if (session.messages.some(message => message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason))) throw new Error('Solution model execution failed');
    report?.({ actor: role, label: 'Agent execution', state: 'completed' });
    return session.getLastAssistantText() || '';
  } catch (error) {
    report?.({ actor: role, label: 'Agent execution', state: 'failed' });
    throw error;
  } finally {
    unsubscribe();
    timer.dispose();
    signal.removeEventListener('abort', abort);
    session.dispose();
  }
}
