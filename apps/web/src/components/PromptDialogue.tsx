import { ArrowUp, Bot, ChevronDown, ChevronRight, Circle, Square, Terminal, Timer } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { EditActivity, EditAttempt } from '@dreamatic/project-data';
import { projectFileUrl, solutionFileUrl, type EditorTask, type SolutionTask, type SolutionVersion } from '../api';
import type { ProjectFile } from '../types';
import { useI18n } from '../i18n';

export type PromptTask = EditorTask | SolutionTask;

const actionNames: Record<string, string> = { submit_solution_revision: 'Submit revision plan', plan_showcase: 'Plan showcase', read: 'Read file', select_base_image: 'Choose base image' };
const actorNames = { designer: 'Designer', builder: 'Builder', editor: 'Editor', image: 'Image service', system: 'System' } as const;

function activityGroups(events: EditActivity[]) {
  const groups: Array<{ actor: EditActivity['actor']; actions: EditActivity[] }> = [];
  for (const event of events) {
    let group = groups.at(-1);
    if (!group || group.actor !== event.actor) {
      group = { actor: event.actor, actions: [] };
      groups.push(group);
    }
    const pending = event.state === 'started' ? -1 : group.actions.findIndex(
      action => action.state === 'started' && action.label === event.label &&
        (event.callId ? action.callId === event.callId : action.detail === event.detail)
    );
    if (pending < 0) group.actions.push(event);
    else group.actions[pending] = event;
  }
  return groups;
}

function activityStatus(event: EditActivity, events: EditActivity[], finished: boolean) {
  if (event.state === 'started') return finished ? 'interrupted' : 'started';
  if (event.label !== 'plan_showcase') return event.state;
  const index = events.indexOf(event);
  if (event.state === 'failed') {
    if (events.some((entry, position) => entry.label === event.label && entry.state === 'completed' && position > index)) return 'Rejected, later corrected';
    return finished ? 'failed' : 'Awaiting correction';
  }
  return events.some((entry, position) => entry.label === event.label && entry.state === 'failed' && position < index) ? 'Corrected' : 'completed';
}

function AttemptLog({ attempt, interrupted, latest }: { attempt: EditAttempt; interrupted: boolean; latest: boolean }) {
  const { t, language } = useI18n();
  const duration = (ms: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Math.max(0, ms) / 1000) + ' ' + t('sec');
  const start = attempt.startedAt ? Date.parse(attempt.startedAt) : undefined;
  const end = attempt.endedAt ? Date.parse(attempt.endedAt) : undefined;
  const finished = Boolean(attempt.status || interrupted);
  const elapsed = end === undefined ? undefined : duration(end - Date.parse(attempt.submittedAt));
  const queue = start === undefined ? (end === undefined ? undefined : elapsed) : duration(start - Date.parse(attempt.submittedAt));
  const execution = start === undefined || end === undefined ? undefined : duration(end - start);
  return <details className="prompt-attempt" open={latest || undefined}>
    <summary><ChevronRight size={12} aria-hidden="true" />{t('Attempt')} {attempt.number}{attempt.status && <small>{t(attempt.status)}</small>}</summary>
    <div className="workflow-stream prompt-activity">
      {activityGroups(attempt.events).map(({ actor, actions }, index) => {
        const status = actions.some(action => action.state === 'started') && !finished ? 'running'
          : actions.at(-1)?.state === 'failed' ? 'error' : finished && actions.at(-1)?.state === 'started' ? 'interrupted' : 'completed';
        const visibleActions = actions.length > 1 ? actions.filter(action => action.label !== 'Agent execution') : actions;
        return <div key={index} className={`workflow-node workflow-agent-node ${status}`}>
          <span className="workflow-dot"><Bot size={13} aria-hidden="true" /></span>
          <details className="workflow-agent-card" open={latest || undefined}>
            <summary><span><strong>{t(actorNames[actor])}</strong><small>{t(status)}</small></span><ChevronDown size={14} aria-hidden="true" /></summary>
            <ol className="workflow-agent-body prompt-action-list">
              {visibleActions.map((event, actionIndex) => <li key={actionIndex} data-state={event.state}>
                <Circle size={7} fill="currentColor" aria-hidden="true" />
                <span>{t(actionNames[event.label] ?? event.label)}{event.detail && <small>{event.detail}</small>}</span>
                <small title={new Date(event.at).toLocaleString()}>{t(activityStatus(event, attempt.events, finished))}</small>
              </li>)}
            </ol>
          </details>
        </div>;
      })}
    </div>
    {finished && <div className="workflow-message-row assistant"><div className="workflow-message-bubble prompt-task-summary">
      <strong><Timer size={13} aria-hidden="true" />{t('Execution summary')}</strong>
      <dl>
        <div><dt>{t('Queue time')}</dt><dd>{queue ?? t('Not reported')}</dd></div>
        <div><dt>{t('Execution time')}</dt><dd>{execution ?? t('Not reported')}</dd></div>
        <div><dt>{t('Reported tokens')}</dt><dd>{attempt.reportedCalls ? attempt.reportedTokens.toLocaleString(language) : t('Not reported')}</dd></div>
      </dl>
      {attempt.reportedCalls > 0 && attempt.unreportedCalls > 0 && <small>{t('Some calls did not report token usage.')}</small>}
    </div></div>}
  </details>;
}

export function PromptDialogue({ tasks, versions, files, runId, latestId, children }: {
  tasks: PromptTask[]; versions: SolutionVersion[]; files: ProjectFile[]; runId?: string; latestId?: string; children: ReactNode;
}) {
  const { t } = useI18n();
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastActivity = tasks.map(task => `${task.id}:${task.status}:${task.activity?.at(-1)?.events.length ?? 0}:${task.activity?.at(-1)?.endedAt ?? ''}`).join('/');
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [lastActivity]);
  return <div className="prompt-dialog-body">
    <aside className="prompt-dialog-inputs" aria-label={t('Input')}>{children}</aside>
    <div className="agent-scroll prompt-dialog-content" ref={scroll} tabIndex={0} role="region" aria-label={t('Prompt conversation')} onScroll={event => {
      const node = event.currentTarget;
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 36;
    }}>
      {tasks.map(task => {
        const solution = 'parentIds' in task;
        const active = ['waiting', 'submitted', 'running'].includes(task.status);
        return <section key={task.id} className="prompt-exchange">
          <div className="workflow-message-row user"><div className="workflow-message-bubble">
            <small>{t('You')}{task.createdAt ? ` · ${new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</small>
            <p className="prompt-user-message">{task.originalPrompt ?? (solution && task.materialEdit ? t(task.prompt) : task.prompt)}</p>
          </div></div>
          <details className="prompt-submitted-inputs">
            <summary>{t('Submitted inputs')}</summary>
            <ol>{(solution ? [...task.parentIds, ...(task.materialEdit?.fileIds ?? [])] : task.inputIds).map((id, index) => <li key={id}>
              {versions.find(version => version.id === id)?.title ?? files.find(file => file.id === id)?.title ?? id}
              {solution && task.sourceNotes[index] ? ` — ${task.sourceNotes[index]}` : ''}
            </li>)}</ol>
          </details>
          {task.activity?.map((attempt, index) => <AttemptLog key={attempt.number} attempt={attempt} latest={task.id === latestId && index === task.activity!.length - 1} interrupted={!attempt.endedAt && (!active || index < task.activity!.length - 1)} />)}
          {!task.activity?.length && !active && <p className="prompt-legacy-summary">{t('Execution summary')} · {t('Not reported')}</p>}
          {task.status === 'succeeded' && <div className="prompt-task-results">
            <strong>{t('Deliverables')}</strong>
            {!solution && task.size && <small>{t('Output size')}: {task.size}</small>}
            {!solution && task.baseImageId && task.sizeSource !== 'user' && <small>{t('Base image')}: {files.find(file => file.id === task.baseImageId)?.title ?? task.baseImageId}</small>}
            {solution ? task.outputIds.map(id => {
              const version = versions.find(entry => entry.id === id);
              return version ? <a key={id} href={solutionFileUrl(version, version.showcasePath)} target="_blank" rel="noreferrer">{version.title}</a> : <span key={id}>{t('Solution version')}</span>;
            }) : task.output && runId && <a href={projectFileUrl(runId, task.output.id)} target="_blank" rel="noreferrer">{task.output.title}</a>}
          </div>}
        </section>;
      })}
    </div>
  </div>;
}

export function PromptComposer({ value, busy, canSend, canStop, label, update, send, stop, begin, end }: {
  value: string; busy: boolean; canSend: boolean; canStop: boolean; label: string;
  update: (value: string) => void; send: () => void; stop: () => void; begin: () => void; end: () => void;
}) {
  const { t, language } = useI18n();
  const menu = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const commands = language === 'zh' ? ['/修改', '/重排', '/融合', '/拆分 3', '/替换'] : ['/edit', '/recompose', '/fuse', '/split 3', '/replace'];
  return <div className="composer prompt-composer">
    <textarea ref={input} disabled={busy} rows={2} aria-label={t('Edit prompt')} value={value} placeholder={t('Write a prompt or type / for a command…')} onFocus={begin} onBlur={end} onChange={event => update(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (canSend) send();
      }
    }} />
    <div className="prompt-composer-actions">
      <details ref={menu} className="prompt-command-menu">
        <summary aria-label={t('Commands')} title={t('Commands')}><Terminal size={15} /></summary>
        <div>{commands.map(command => <button key={command} disabled={busy} onClick={() => {
          update(`${command} ${value.startsWith('/') ? '' : value}`);
          if (menu.current) menu.current.open = false;
          input.current?.focus();
        }}>{command}</button>)}</div>
      </details>
      <button type="button" className={`send${busy ? ' is-stop' : ''}`} aria-label={t(busy ? 'Cancel' : label)} title={t(busy ? 'Cancel' : 'Send message')} disabled={busy ? !canStop : !canSend} onClick={busy ? stop : send}>
        {busy ? <Square size={12} fill="currentColor" /> : <ArrowUp size={17} />}
      </button>
    </div>
  </div>;
}
