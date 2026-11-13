import type { createDreamaticAgent } from './agent-session.js';
import { modelActivityUsage, type EditActivityReporter } from './edit-activity.js';
import { setting } from './design-pipeline.js';
import { createModelResponseTimer } from './model-response-timer.js';

function responseFailureDetail(timer: ReturnType<typeof createModelResponseTimer>, stopReason?: string) {
  const { startedAt, timedOutAt, lastOutput, lastStreamEvent } = timer.diagnostics;
  const describe = (event?: { type: string; at: number }) =>
    event ? `${event.type} at ${new Date(event.at).toISOString()}` : 'none';
  return [
    `Model stop reason: ${stopReason ?? 'not reported'}`,
    ...(timer.failure ? [`Timeout phase: ${timer.failure}`] : []),
    ...(startedAt !== undefined ? [`Response started: ${new Date(startedAt).toISOString()}`] : []),
    `Last effective output: ${describe(lastOutput)}`,
    `Last observed stream event: ${describe(lastStreamEvent)}`,
    ...(timedOutAt !== undefined ? [`Timed out: ${new Date(timedOutAt).toISOString()}`] : []),
  ].join(' · ');
}

export async function promptSolutionModel(agent: Awaited<ReturnType<typeof createDreamaticAgent>>, text: string, signal: AbortSignal, role: 'editor' | 'builder', report?: EditActivityReporter, recovery?: { shouldStop: () => boolean; retryIf: () => boolean; retryMessage: () => string; failureMessage?: () => string }) {
  const { session, prompt } = agent;
  const abort = () => { void session.abort(); };
  const timer = createModelResponseTimer({
    firstOutputMs: Number(setting(`DREAMATIC_MODEL_TURN_TIMEOUT_MS_${role.toUpperCase()}`) || setting('DREAMATIC_MODEL_TURN_TIMEOUT_MS')),
    generationMs: Number(setting('DREAMATIC_MODEL_GENERATION_TIMEOUT_MS')),
    idleMs: Number(setting('DREAMATIC_MODEL_IDLE_TIMEOUT_MS')),
    totalMs: Number(setting('DREAMATIC_MODEL_TOTAL_TIMEOUT_MS')),
    onTimeout: abort,
  });
  let timeoutReported = false;
  report?.({ actor: role, label: 'Agent execution', state: 'started' });
  const unsubscribe = session.subscribe(event => {
    timer.handle(event);
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const failed = Boolean(timer.failure) || event.message.stopReason === 'error' || event.message.stopReason === 'aborted';
      timeoutReported ||= Boolean(timer.failure);
      report?.({
        actor: role, label: 'Model response', state: failed ? 'failed' : 'completed',
        ...(failed ? { detail: responseFailureDetail(timer, event.message.stopReason) } : {}),
      }, modelActivityUsage(event.message.usage));
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const detail = event.type === 'tool_execution_end' && event.isError && event.toolName === 'plan_showcase'
        ? event.result.content.find((block: { type: string; text?: string }) => block.type === 'text')?.text?.slice(0, 1800)
        : undefined;
      report?.({ actor: role, label: event.toolName, callId: event.toolCallId,
        state: event.type === 'tool_execution_start' ? 'started' : event.isError ? 'failed' : 'completed',
        ...(detail ? { detail } : {}) });
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
    if (recovery?.failureMessage && recovery.shouldStop()) throw new Error(recovery.failureMessage());
    if (session.messages.some(message => message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason))) throw new Error('Solution model execution failed');
    if (recovery?.failureMessage && recovery.retryIf()) throw new Error(recovery.failureMessage());
    report?.({ actor: role, label: 'Agent execution', state: 'completed' });
    return session.getLastAssistantText() || '';
  } catch (error) {
    if (timer.failure && !timeoutReported) {
      report?.({ actor: role, label: 'Model response', state: 'failed', detail: responseFailureDetail(timer) }, {});
    }
    report?.({ actor: role, label: 'Agent execution', state: 'failed' });
    throw error;
  } finally {
    unsubscribe();
    timer.dispose();
    signal.removeEventListener('abort', abort);
    session.dispose();
  }
}
