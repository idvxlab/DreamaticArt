import { SolutionStageDetails } from './SolutionProgress';
import { solutionOperationLabel, solutionSourceRole } from './SolutionPrompt';
import { ArrowUp, Bot, ChevronDown, ChevronRight, Circle, Terminal, Timer } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { EditActivity, EditAttempt } from '@dreamatic/project-data';
import { projectFileUrl, solutionFileUrl, type EditorTask, type SolutionTask, type SolutionVersion } from '../api';
import { commands as commandAliases, operationCommand } from '../prompt-commands';
import type { SolutionTaskInput } from '../api';
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

function AttemptLog({ attempt, interrupted, latest, id, collapsed, children }: { attempt: EditAttempt; interrupted: boolean; latest: boolean; id?: string; collapsed?: boolean; children?: ReactNode }) {
  const { t, language } = useI18n();
  const duration = (ms: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Math.max(0, ms) / 1000) + ' ' + t('sec');
  const start = attempt.startedAt ? Date.parse(attempt.startedAt) : undefined;
  const end = attempt.endedAt ? Date.parse(attempt.endedAt) : undefined;
  const finished = Boolean(attempt.status || interrupted);
  const elapsed = end === undefined ? undefined : duration(end - Date.parse(attempt.submittedAt));
  const queue = start === undefined ? (end === undefined ? undefined : elapsed) : duration(start - Date.parse(attempt.submittedAt));
  const execution = start === undefined || end === undefined ? undefined : duration(end - start);
  return <details id={id} className="prompt-attempt" open={(latest && !collapsed) || undefined}>
    <summary><ChevronRight size={12} aria-hidden="true" />{t('Attempt')} {attempt.number}{attempt.status && <small>{t(attempt.status)}</small>}</summary>
    {children}
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
        const historyLabel = solution && task.operation === 'split' && task.outputCount >= 2
          ? t('Split into {count} versions').replace('{count}', String(task.outputCount))
          : solution ? t(task.materialEdit
          ? task.materialEdit.mode === 'replace' ? 'Replace material' : 'Integrate materials'
          : solutionOperationLabel(task.operation)) : t('Edit images');
        const InputList = solution ? 'ul' : 'ol';
        const active = ['waiting', 'submitted', 'running'].includes(task.status);
        return <section key={task.id} className="prompt-exchange">
          <div className="workflow-message-row user"><div className="workflow-message-bubble">
            <small>{historyLabel}{task.createdAt ? ` · ${new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</small>
            <p className="prompt-user-message">{task.originalPrompt ?? (solution && task.materialEdit ? t(task.prompt) : task.prompt)}</p>
          </div></div>
          <details className="prompt-submitted-inputs">
            <summary>{t('Submitted inputs')}</summary>
            <InputList>{(solution ? [...task.parentIds, ...(task.materialEdit?.fileIds ?? [])] : task.inputIds).map((id, index) => <li key={id}>
              {solution && <small className="prompt-source-role">{t(index < task.parentIds.length ? solutionSourceRole(task.parentIds.length, index) : 'Assets')}</small>}
              {versions.find(version => version.id === id)?.title ?? files.find(file => file.id === id)?.title ?? id}
              {solution && task.sourceNotes[index] ? ` — ${task.sourceNotes[index]}` : ''}
            </li>)}</InputList>
          </details>
          {task.activity?.map((attempt, index) => <AttemptLog key={attempt.number} attempt={attempt} collapsed={solution} id={index === task.activity!.length - 1 ? `prompt-details-${task.id}` : undefined} latest={task.id === latestId && index === task.activity!.length - 1} interrupted={!attempt.endedAt && (!active || index < task.activity!.length - 1)}>{solution && index === task.activity!.length - 1 && <SolutionStageDetails task={task} />}</AttemptLog>)}
          {task.error && <p role="alert" className="prompt-task-error">{t(task.error)}</p>}
          {!task.activity?.length && !active && <p className="prompt-legacy-summary">{t('Execution summary')} · {t('Not reported')}</p>}
          {task.status === 'succeeded' && <div className="prompt-task-results" id={`prompt-results-${task.id}`} tabIndex={-1}>
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

export function PromptComposer({ value, canSend, label, commands, update, send, begin, end }: {
  value: string; canSend: boolean; label: string; commands: SolutionTaskInput['operation'][];
  update: (value: string) => void; send: () => void; begin: () => void; end: () => void;
}) {
  const { t, language } = useI18n();
  const input = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [manual, setManual] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const [active, setActive] = useState(0);
  const prefix = /^\s*\/([^\s]*)$/u.exec(value)?.[1]?.toLowerCase();
  const options = commands.filter(operation => manual || prefix === undefined || Object.keys(commandAliases).some(alias =>
    alias.startsWith(prefix) && (commandAliases[alias as keyof typeof commandAliases] === (operation === 'revise' ? 'edit' : operation))));
  const open = (manual || (focused && prefix !== undefined && dismissed !== value)) && options.length > 0;
  const selected = Math.min(active, options.length - 1);
  function choose(operation: SolutionTaskInput['operation']) {
    const body = value.trimStart().replace(/^\/[^\s]*(?:[ \t]+|\n)?/u, '');
    update(`${operationCommand(operation, language === 'zh')} ${body}`);
    setManual(false);
    setActive(0);
    input.current?.focus();
  }
  return <div className="composer prompt-composer">
    <textarea ref={input} rows={2} aria-label={t('Edit prompt')} value={value} placeholder={t('Write a prompt or type / for a command…')}
      onFocus={() => { setFocused(true); begin(); }} onBlur={() => { setFocused(false); setManual(false); end(); }}
      onChange={event => { setManual(false); setDismissed(undefined); setActive(0); update(event.target.value); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (open && ['ArrowDown', 'ArrowUp', 'Escape', 'Enter'].includes(event.key) && !event.shiftKey) {
        event.preventDefault();
        if (event.key === 'Escape') { setManual(false); setDismissed(value); }
        else if (event.key === 'Enter') choose(options[selected]!);
        else setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (canSend) send();
      }
    }} />
    <div className="prompt-composer-actions">
      {commands.length > 0 && <div className="prompt-command-menu">
        <button type="button" aria-label={t('Commands')} aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => {
          input.current?.focus();
          if (open) setDismissed(value);
          setManual(!open);
        }}><Terminal size={15} /></button>
        {open && <div className="prompt-command-options">{options.map((operation, index) =>
          <button type="button" key={operation} className={index === selected ? 'is-active' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(operation)}>{operationCommand(operation, language === 'zh')}</button>)}</div>}
      </div>}
      <button type="button" className="send" aria-label={t(label)} title={t('Send message')} disabled={!canSend} onClick={send}>
        <ArrowUp size={17} />
      </button>
    </div>
  </div>;
}
