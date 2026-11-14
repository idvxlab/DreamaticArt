import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { solutionFileUrl, type SolutionTask, type SolutionVersion } from '../api';
import { useI18n } from '../i18n';

const stages = [
  ['planning', 'Planning revision'],
  ['images', 'Preparing images'],
  ['showcase', 'Composing showcase'],
  ['publishing', 'Saving new versions'],
] as const;
const imageActions = [
  ['reuse', 'Reuse image', 'Reused images'],
  ['edit', 'Edit image', 'Edited images'],
  ['generate', 'Generate image', 'Generated images'],
] as const;

export function SolutionStageDetails({ task }: { task: SolutionTask }) {
  const { t } = useI18n();
  const events = task.activity?.at(-1)?.events ?? [];
  const current = stages.findIndex(([id]) => id === task.phase);
  const reused = events.some(event => event.label === 'Reuse showcase' && event.state === 'completed');
  return <>
    <ol className="solution-progress-stages" aria-label={t('Edit progress')}>
      {stages.map(([id, label], index) => {
        const done = task.status === 'succeeded' || index < current;
        const selected = index === current && !done;
        return <li key={id} data-state={done ? 'done' : selected ? 'current' : 'pending'} aria-current={selected ? 'step' : undefined}>
          <span aria-hidden="true">{done ? '✓' : selected ? '●' : '○'}</span>
          {t(id === 'showcase' && reused && task.outputCount === 1 ? 'Showcase reused' : label)}
        </li>;
      })}
    </ol>
    <div className="solution-progress-meta">{imageActions.map(([key, label, name]) => {
      const total = task.imageProgress?.totals[key];
      const count = task.imageProgress?.completed[key] ?? events.filter(event => event.label === label && event.state === 'completed').length;
      return (total || count) ? <small key={key}>{t(name)} {count}{total ? `/${total}` : ''}</small> : null;
    })}</div>
  </>;
}

export function SolutionProgress({ task, versions, retry, cancel, showDetails, showResults }: {
  task: SolutionTask;
  versions: SolutionVersion[];
  retry: () => void;
  cancel: () => void;
  showResults: () => void;
  showDetails: () => void;
}) {
  const { t } = useI18n();
  const active = task.status === 'running' || task.status === 'waiting';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, task.id]);
  const attempt = task.activity?.at(-1);
  const events = attempt?.events ?? [];
  const last = events.at(-1);
  const latestOf = (labels: string[]) => events.filter(event => labels.includes(event.label)).at(-1);
  const plan = latestOf(['Revision plan validation', 'submit_solution_append', 'submit_image_replacement', 'submit_solution_revision', 'Retry revision planning']);
  const image = latestOf(imageActions.map(([, label]) => label));
  const phase = task.phase;
  const current = stages.findIndex(([id]) => id === phase);
  const queued = task.status === 'waiting' || (!active && !attempt?.startedAt);
  const elapsed = (time: string | undefined, end = now) => {
    const seconds = time ? Math.max(0, Math.floor((end - Date.parse(time)) / 1000)) : NaN;
    if (!Number.isFinite(seconds)) return '';
    return seconds < 60 ? `${seconds} ${t('sec')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const started = attempt?.startedAt;
  const execution = elapsed(queued ? attempt?.submittedAt ?? task.createdAt : started, attempt?.endedAt ? Date.parse(attempt.endedAt) : now);
  const silence = active && !queued && last && now - Date.parse(last.at) >= 30000 ? elapsed(last.at) : '';
  let headline = !active ? t(task.status) : queued ? t('Waiting for another solution edit') : t(stages[current]?.[1] ?? 'Planning revision');
  if (active && !queued && phase === 'planning') {
    if (plan?.label === 'Retry revision planning') headline = t('Retrying revision planning');
    else if (plan?.state === 'failed') headline = t('Correcting revision plan');
  }
  const waitingForImage = phase === 'images' && image?.state === 'started';
  const output = Math.min((task.completed ?? 0) + 1, task.outputCount);
  const results = task.outputIds.flatMap(id => versions.filter(version => version.id === id));
  const generated = task.imageProgress?.totals.generate;
  const edited = task.imageProgress?.totals.edit;
  const imageCount = generated ? `${t('Generated images')} ${task.imageProgress!.completed.generate}/${generated}`
    : edited ? `${t('Edited images')} ${task.imageProgress!.completed.edit}/${edited}`
    : events.filter(event => event.state === 'completed' && ['Edit image', 'Generate image'].includes(event.label)).length;
  const secondary = active && !queued ? [
    task.outputCount > 1 && current > 0 && current < 3 ? `${t('Solution version')} ${output}/${task.outputCount}` : '',
    phase === 'images' && imageCount ? typeof imageCount === 'number' ? `${t('Images completed')} ${imageCount}` : imageCount : '',
    silence ? `${t(waitingForImage ? 'Waiting for image service' : 'Time since last update')} ${silence}` : '',
  ].filter(Boolean).slice(0, 2).join(' · ') : '';
  const failure = !active && task.status !== 'succeeded' ? [t(stages[current]?.[1] ?? 'Planning revision'), task.error].filter(Boolean).join(' · ') : '';
  return <section className="solution-progress">
    <div className="prompt-dialog-status">
      <span role="status" data-task-status={task.status}>
        {active && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
        <strong>{task.status === 'succeeded' ? t('New version ready') : headline}</strong>
      </span>
      {execution && <small>{t(queued || !started ? 'Queue time' : 'Execution time')} {execution}</small>}
    </div>
    {(secondary || failure) && <small className="solution-progress-current-image" title={secondary || failure}>{secondary || failure}</small>}
    <div className="prompt-footer-actions">
      {task.status !== 'succeeded' && attempt && <button type="button" onClick={showDetails}>{t('View execution details')}</button>}
      {active ? <button type="button" onClick={cancel}>{t('Cancel')}</button>
        : task.status !== 'succeeded' ? <button type="button" onClick={retry}>{t('Retry')}</button>
        : task.outputIds.length === 1 && results[0] ? <a href={solutionFileUrl(results[0], results[0].showcasePath)} target="_blank" rel="noreferrer">{t('Open new version')}</a>
        : <button type="button" onClick={showResults}>{t('View results')}</button>}
    </div>
  </section>;
}
