import type { EditActivity, EditAttempt } from '@dreamatic/project-data';
import { imageUsageTokens } from './completion-summary.js';

export type EditActivityReporter = (activity: Omit<EditActivity, 'at'>, usage?: { tokens?: number }) => void;

export function modelActivityUsage(value: unknown) {
  const usage = value as { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
  const counts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite];
  const total = usage?.totalTokens ?? (counts.every(value => Number.isFinite(value) && value! >= 0)
    ? counts.reduce<number>((sum, value) => sum + value!, 0) : undefined);
  return { ...(typeof total === 'number' && Number.isFinite(total) && total > 0 ? { tokens: total } : {}) };
}

export function imageActivityUsage(value: unknown) {
  const tokens = imageUsageTokens(value);
  return tokens === undefined ? {} : { tokens };
}

export function editActivityLog(number: number, snapshot: () => () => Promise<void>) {
  const attempt: EditAttempt = {
    number, submittedAt: new Date().toISOString(), events: [],
    reportedTokens: 0, reportedCalls: 0, unreportedCalls: 0,
  };
  let pending = Promise.resolve();
  function write() {
    const persist = snapshot();
    pending = pending.catch(() => undefined).then(persist);
    void pending.catch(error => console.error('Could not save edit activity', error instanceof Error ? error.message : 'storage failure'));
    return pending;
  }
  const report: EditActivityReporter = (activity, usage) => {
    attempt.events.push({ ...activity, at: new Date().toISOString() });
    if (usage) {
      if (usage.tokens === undefined) attempt.unreportedCalls++;
      else { attempt.reportedTokens += usage.tokens; attempt.reportedCalls++; }
    }
    void write();
  };
  return {
    attempt, report, write,
    start() { attempt.startedAt = new Date().toISOString(); return write(); },
    finish(status: NonNullable<EditAttempt['status']>) {
      attempt.endedAt = new Date().toISOString();
      attempt.status = status;
      return write();
    },
  };
}
