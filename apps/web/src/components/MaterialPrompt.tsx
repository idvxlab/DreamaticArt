import { ArrowRight, Check, Film, Plus, Replace } from 'lucide-react';
import { solutionFileUrl, type SolutionVersion } from '../api';
import { useI18n } from '../i18n';
import type { CanvasElementState, ProjectFile } from '../types';
import { FileListPreview } from './FileListPreview';

export function materialTargets(version: SolutionVersion, files: ProjectFile[]) {
  if (files.length !== 1) return [];
  return /^(mp4|webm)$/iu.test(files[0]!.kind) ? version.videos ?? [] : version.images;
}

export function MaterialPrompt({ item, version, files, busy, update }: {
  item: CanvasElementState;
  version?: SolutionVersion;
  files: ProjectFile[];
  busy: boolean;
  update: (fields: Partial<CanvasElementState>) => void;
}) {
  const { t } = useI18n();
  const mode = item.materialMode ?? 'integrate';
  const sections = [...new Set(version?.works?.map(work => work.section) ?? [])];
  const targets = version ? materialTargets(version, files) : [];
  const target = targets.find(entry => entry.id === item.materialTargetId);
  const isVideo = Boolean(version?.videos?.some(video => video.id === target?.id));
  const title = (id: string) => version?.works?.find(work => work.id === id)?.section ?? id;
  return <div className="material-edit-form">
    {version && <div className="material-input-row"><img src={solutionFileUrl(version, version.coverPath)} alt="" /><span><small>{t('Solution version')}</small><strong>{version.title}</strong></span></div>}
    <ul className="material-input-list">
      {files.map(file => <li className="material-input-row" key={file.id}><FileListPreview file={file} runId={version?.runId} /><span><small>{t('Assets')}</small><strong>{file.title}</strong></span></li>)}
    </ul>
    <div className="material-mode-switch" role="group" aria-label={t('Material operation')}>
      <button type="button" disabled={busy} aria-pressed={mode === 'integrate'} onClick={() => update({ materialMode: 'integrate' })}><Plus size={15} aria-hidden="true" />{t('Integrate materials')}</button>
      <button type="button" disabled={busy} aria-pressed={mode === 'replace'} onClick={() => update({ materialMode: 'replace' })}><Replace size={15} aria-hidden="true" />{t('Replace material')}</button>
    </div>
    {mode === 'integrate' && <label className="material-section-field">{t('Showcase placement')}
      <select disabled={busy} value={sections.includes(item.materialSection ?? '') ? item.materialSection : ''} onChange={event => update({ materialSection: event.target.value || undefined })}>
        <option value="">{t('Automatic placement')}</option>
        {sections.map(section => <option key={section}>{section}</option>)}
      </select>
    </label>}
    {mode === 'replace' && (files.length !== 1 ? <p>{t('Connect exactly one replacement material.')}</p> : !targets.length ? <p>{t('This solution has no material of the same type.')}</p> :
      <fieldset disabled={busy} className="material-targets">
        <legend>{t('Choose the material to replace')}</legend>
        <div className="material-target-grid">{targets.map(entry => <button type="button" key={entry.id}
          aria-label={`${title(entry.id)} (${entry.id})`} aria-pressed={target?.id === entry.id} onClick={() => update({ materialTargetId: entry.id })}>
          <span className="material-target-preview">{version?.videos?.some(video => video.id === entry.id)
            ? <Film size={23} aria-hidden="true" />
            : <img src={solutionFileUrl(version!, entry.path)} alt="" />}
            {target?.id === entry.id && <Check className="material-target-check" size={17} aria-hidden="true" />}
          </span>
          <strong>{title(entry.id)}</strong><small title={entry.id}>{entry.id}</small>
        </button>)}</div>
      </fieldset>)}
    {target && mode === 'replace' && <p className="material-replacement-preview"><span>{isVideo && 'title' in target ? String(target.title) : title(target.id)}</span><ArrowRight size={15} aria-hidden="true" /><strong>{files[0]?.title}</strong></p>}
  </div>;
}
