import { ArrowUp } from 'lucide-react';
import { operationCommand, promptCommand } from '../prompt-commands';
import type { SolutionTaskInput, SolutionVersion } from '../api';
import { useI18n } from '../i18n';
import type { CanvasElementState } from '../types';

const operations = [
  ['revise', 'Revise solution'],
  ['append', 'Append to solution'],
  ['recompose', 'Recompose showcase'],
  ['replace', 'Replace image'],
  ['fuse', 'Fuse solutions'],
  ['split', 'Split solution'],
] as const;

export function solutionOperationLabel(operation: SolutionTaskInput['operation']) {
  return operations.find(([value]) => value === operation)?.[1] ?? 'Prompt';
}

export function solutionSourceRole(count: number, index: number) {
  return count === 1 ? 'Based on' : index === 0 ? 'Primary solution' : 'Reference solution';
}

export function solutionPromptOptions(item: CanvasElementState, sources: SolutionVersion[], inferredOperation?: SolutionTaskInput['operation']) {
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
  const append = /只追加|仅追加|追加|(?:保留|不修改|不改).{0,24}(?:新增|增加|添加|补充|加入)|(?:新增|添加|补充|增加).{0,20}(?:新图|图片|设计图)|\bappend\b|\badd\b.{0,30}\bnew (?:images?|sections?)\b/iu.test(text);
  const revise = /修改|改成|调整|改善|优化|重做|\b(?:revise|edit|improve|change)\b/iu.test(text) && !append && !recompose && !replaceImage;
  const matching = [split || (raw !== undefined && outputCount > 1) ? 'split' : undefined,
    fuse ? 'fuse' : undefined, recompose ? 'recompose' : undefined, replaceImage ? 'replace' : undefined,
    append ? 'append' : undefined, revise ? 'revise' : undefined].filter((value): value is SolutionTaskInput['operation'] => Boolean(value));
  const eligible = operations.map(([value]) => value).filter(value => sources.length === 1
    ? value !== 'fuse' && (value !== 'replace' || sources[0]!.images.length > 0)
    : value === 'fuse' && sources.length >= 2 && sources.length <= 8);
  const operation = command.operation ?? inferredOperation ?? (matching.length === 1 ? matching[0] : undefined);
  const candidatesForQuestion: readonly SolutionTaskInput['operation'][] = matching.length ? matching : sources.length === 1 && /增加|加入|丰富|\badd\b/iu.test(text)
    ? ['revise', 'append'] as const : eligible;
  const compatibleChoices = eligible.filter(value => candidatesForQuestion.includes(value));
  const choices = !operation && text ? (compatibleChoices.length ? compatibleChoices : eligible) : [];
  const replacement = item.replacement || (candidates.length === 1 ? candidates[0]?.id
    : /主视觉|封面|\b(?:hero|cover)\b/iu.test(text) ? sources[0]?.heroId
    : sources[0]?.images.length === 1 ? sources[0].images[0]?.id : undefined);
  const countKnown = command.count !== undefined || item.outputCount !== undefined || raw !== undefined;
  const canRun = Boolean(operation && eligible.includes(operation) &&
    (operation !== 'replace' || sources[0]?.images.some(image => image.id === replacement)) &&
    (operation !== 'split' || (countKnown && [2, 3, 4].includes(outputCount))));
  return { operation, outputCount, countKnown, replacement, canRun, choices, eligible };
}

export function SolutionPrompt({ item, sources, busy, update, moveInput, resolution }: {
  item: CanvasElementState; sources: SolutionVersion[]; busy: boolean;
  update: (fields: Partial<CanvasElementState>) => void; moveInput: (index: number) => void; resolution: ReturnType<typeof solutionPromptOptions>;
}) {
  const { t, language } = useI18n();
  const { operation, outputCount, countKnown, replacement, canRun, choices } = resolution;
  return <>
    {sources.length > 0 && <>
      {choices.length > 0 && <fieldset className="prompt-operation-choices" disabled={busy}>
        <legend>{t('Which operation do you want?')}</legend>
        {operations.filter(([value]) => choices.includes(value)).map(([value, label]) =>
          <button type="button" key={value} onClick={() => update({ text: `${operationCommand(value, language === 'zh')} ${item.text?.trim() ?? ''}`, operation: undefined })}>{t(label)}</button>)}
      </fieldset>}
      {operation === 'split' && (!countKnown || ![2, 3, 4].includes(outputCount)) && <fieldset className="prompt-operation-choices" disabled={busy}>
        <legend>{t('How many versions should be created?')}</legend>
        {[2, 3, 4].map(count => <button type="button" key={count} onClick={() => update({ outputCount: count })}>{count}</button>)}
      </fieldset>}
      {operation === 'replace' && <label>{t('Image to replace')} <select disabled={busy} value={replacement ?? ''} onChange={event => update({ replacement: event.target.value })}>
        <option value="">{t('Select image')}</option>{sources[0]?.images.map(image => <option key={image.id}>{image.id}</option>)}
      </select></label>}
      <ul className="solution-inputs" aria-label={t('Input versions')}>
        {sources.map((version, index) => <li key={version.id}>
          <small className="prompt-source-role">{t(solutionSourceRole(sources.length, index))}</small>
          <span title={version.title}>{version.title}</span>
          {sources.length > 1 && <><input aria-label={`${t('Source role')} ${index + 1}`} placeholder={t(index === 0 ? 'Primary solution' : 'Source role')} value={item.sourceNotes?.[version.id] ?? ''} disabled={busy} onChange={event => update({ sourceNotes: { ...item.sourceNotes, [version.id]: event.target.value } })} />
            {index > 0 && <button disabled={busy} aria-label={t('Move source up')} onClick={() => moveInput(index)}><ArrowUp size={12} /></button>}</>}
        </li>)}
      </ul>

      {operation === 'replace' && !replacement && <small>{t('Select the image to replace.')}</small>}
      {operation === 'fuse' && !canRun && <small>{t('Connect two to eight versions to fuse them.')}</small>}
      {sources.length > 8 && !operation && <small>{t('Connect two to eight versions to fuse them.')}</small>}
      {sources.length > 1 && operation && operation !== 'fuse' && <small>{t('This operation needs one solution input.')}</small>}
    </>}
  </>;
}
