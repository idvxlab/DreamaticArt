import { ArrowUp } from 'lucide-react';
import { promptCommand } from '../prompt-commands';
import type { SolutionTaskInput, SolutionVersion } from '../api';
import { useI18n } from '../i18n';
import type { CanvasElementState } from '../types';

const operations = [
  ['revise', 'Revise solution'],
  ['recompose', 'Recompose showcase'],
  ['replace', 'Replace image'],
  ['fuse', 'Fuse solutions'],
  ['split', 'Split solution'],
] as const;

export function solutionPromptOptions(item: CanvasElementState, sources: SolutionVersion[]) {
  const command = promptCommand(item.text ?? '');
  const text = command.prompt;
  const split = /\b(?:split|divide|separate)\b|拆分|拆成|分成|拆为|拆出/iu.test(text);
  const fuse = /\b(?:fuse|merge|combine|blend)\b|融合|合并/iu.test(text);
  const recompose = /\b(?:recompose|reorder|rearrange|re-layout)\b|重排|重新编排|只调整.{0,8}展示/iu.test(text);
  const replace = /\b(?:replace|swap)\b|替换|换掉/iu.test(text);
  const counts: Record<string, number> = { two: 2, three: 3, four: 4, '两': 2, '二': 2, '三': 3, '四': 4 };
  const count = text.match(/(?:\b(\d+|two|three|four)\s+(?:independent\s+)?(?:versions?|outputs?|variants?|solutions?|branches|directions)|([两二三四\d]+)\s*(?:个|份|套)?\s*(?:方案|版本|分支|方向))/iu);
  const raw = count?.[1]?.toLowerCase() ?? count?.[2];
  const outputCount = command.count ?? item.outputCount ?? (raw ? counts[raw] ?? Number(raw) : 2);
  const words = new Set(text.toLowerCase().split(/[^a-z0-9_-]+/));
  const candidates = sources[0]?.images.filter(image => words.has(image.id.toLowerCase())) ?? [];
  const replaceImage = replace && (candidates.length > 0 || /\b(?:image|picture|photo|illustration)\b|图|照片/iu.test(text));
  const wantsSplit = split || (sources.length === 1 && raw !== undefined && outputCount > 1);
  const inferred = wantsSplit ? 'split'
    : sources.length > 1 || fuse ? 'fuse'
    : recompose ? 'recompose'
    : replaceImage ? 'replace' : 'revise';
  const operation = command.operation ?? item.operation ?? inferred;
  const replacement = item.replacement || (candidates.length === 1 ? candidates[0]?.id : sources[0]?.images.length === 1 ? sources[0].images[0]?.id : undefined);
  const canRun = (operation === 'fuse' ? sources.length >= 2 && sources.length <= 8 : sources.length === 1) &&
    (operation !== 'replace' || sources[0]?.images.some(image => image.id === replacement)) &&
    (operation !== 'split' || [2, 3, 4].includes(outputCount));
  return { operation, outputCount, replacement, canRun };
}

export function SolutionPrompt({ item, sources, busy, update, moveInput }: {
  item: CanvasElementState; sources: SolutionVersion[]; busy: boolean;
  update: (fields: Partial<CanvasElementState>) => void; moveInput: (index: number) => void;
}) {
  const { t } = useI18n();
  const { operation, outputCount, replacement, canRun } = solutionPromptOptions(item, sources);
  const command = promptCommand(item.text ?? '');
  return <>
    {sources.length > 0 && <>
      <label>{t('Operation')} <select disabled={busy || Boolean(command.operation)} value={command.operation ?? item.operation ?? ''} onChange={event => update({ operation: (event.target.value || undefined) as SolutionTaskInput['operation'] | undefined })}>
        <option value="">{t('Auto')} · {t(operations.find(([value]) => value === operation)![1])}</option>
        {operations.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select></label>
      {operation === 'split' && <label>{t('Outputs')} <select disabled={busy || command.count !== undefined} value={outputCount} onChange={event => update({ outputCount: Number(event.target.value) })}>{![2, 3, 4].includes(outputCount) && <option value={outputCount}>{t('Select output count')}</option>}{[2, 3, 4].map(count => <option key={count}>{count}</option>)}</select></label>}
      {operation === 'replace' && <label>{t('Image to replace')} <select disabled={busy} value={replacement ?? ''} onChange={event => update({ replacement: event.target.value })}>
        <option value="">{t('Select image')}</option>{sources[0]?.images.map(image => <option key={image.id}>{image.id}</option>)}
      </select></label>}
      <ol className="solution-inputs" aria-label={t('Input versions')}>
        {sources.map((version, index) => <li key={version.id}>
          <span title={version.title}>{version.title}</span>
          {sources.length > 1 && <><input aria-label={`${t('Source role')} ${index + 1}`} placeholder={t(index === 0 ? 'Primary solution' : 'Source role')} value={item.sourceNotes?.[version.id] ?? ''} disabled={busy} onChange={event => update({ sourceNotes: { ...item.sourceNotes, [version.id]: event.target.value } })} />
            {index > 0 && <button disabled={busy} aria-label={t('Move source up')} onClick={() => moveInput(index)}><ArrowUp size={12} /></button>}</>}
        </li>)}
      </ol>

      {operation === 'replace' && !replacement && <small>{t('Select the image to replace.')}</small>}
      {operation === 'fuse' && !canRun && <small>{t('Connect two to eight versions to fuse them.')}</small>}
      {sources.length > 1 && operation !== 'fuse' && <small>{t('This operation needs one solution input.')}</small>}
    </>}
  </>;
}
