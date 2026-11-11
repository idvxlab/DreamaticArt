import { FileImage, FileText, GitBranch, Layers3, LayoutTemplate, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { solutionFileUrl, type SolutionVersion } from '../api';
import { SOLUTION_MIME } from '../canvas-media';
import { useI18n } from '../i18n';

export function SolutionLinks({ version }: { version: SolutionVersion }) {
  const { t } = useI18n();
  return <div className="solution-links">
    <a href={solutionFileUrl(version, version.showcasePath)} target="_blank" rel="noreferrer"><LayoutTemplate size={13} aria-hidden="true" />{t('Showcase')}</a>
    <a href={solutionFileUrl(version, version.designPath)} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" />{t('Design document')}</a>
    {version.exhibitionPath
      ? <a href={solutionFileUrl(version, version.exhibitionPath)} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" />{t('Exhibition direction')}</a>
      : <small>{t('Exhibition direction unavailable')}</small>}
  </div>;
}

function SolutionCover({ version }: { version: SolutionVersion }) {
  const url = solutionFileUrl(version, version.coverPath);
  const [failed, setFailed] = useState('');
  return <div className="solution-cover" aria-hidden="true">
    {failed === url ? <FileImage size={23} strokeWidth={1.4} /> :
      <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(url)} />}
  </div>;
}

export function SolutionVersions({ versions, loading, error, onAdd, onRetry }: {
  versions: SolutionVersion[]; loading: boolean; error: boolean; onAdd: (version: SolutionVersion) => void; onRetry: () => void;
}) {
  const { t, language } = useI18n();
  const dateFormat = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium' });
  const titles = new Map(versions.map(version => [version.id, version.title]));
  return <section className="solution-list" aria-label={t('Solution versions')}>
    <header className="library-heading">
      <h3>{t('Solution versions')} <span>{versions.length}</span></h3>
      <button className="library-icon-button" onClick={onRetry} aria-label={t('Refresh versions')} title={t('Refresh versions')}><RefreshCw size={15} /></button>
    </header>
    <div className="solution-list-scroll">
      {error && <p className="library-message" role="alert">{t('Could not load solution versions.')} <button onClick={onRetry}>{t('Retry')}</button></p>}
      {loading && <p className="library-message" role="status">{t('Loading solution versions…')}</p>}
      {!loading && !error && versions.length === 0 && <div className="library-empty"><Layers3 size={24} strokeWidth={1.4} aria-hidden="true" /><p>{t('Complete a design showcase to add its first version here.')}</p></div>}
      {versions.map(version => {
        const created = new Date(version.createdAt);
        const provenance = version.parentIds.length ? version.parentIds.map(id => titles.get(id) ?? id.slice(0, 8)).join(' + ') : t('Original version');
        return <article key={version.id} draggable onDragStart={event => {
          event.dataTransfer.setData(SOLUTION_MIME, JSON.stringify({ runId: version.runId, versionId: version.id }));
          event.dataTransfer.effectAllowed = 'copy';
        }}>
          <div className="solution-list-heading">
            <SolutionCover version={version} />
            <div className="solution-list-detail">
              <strong title={version.title}>{version.title}</strong>
              <div className="solution-list-meta">
                {Number.isFinite(created.getTime()) && <time dateTime={version.createdAt} title={created.toLocaleString()}>{dateFormat.format(created)}</time>}
                <small>{version.images.length} {t(version.images.length === 1 ? 'Design image' : 'Design images')}</small>
              </div>
              <small className="solution-provenance" title={provenance}>
                <GitBranch size={13} aria-hidden="true" /><span>{provenance}</span>
              </small>
            </div>
            <button className="library-icon-button solution-add" onClick={() => onAdd(version)} aria-label={t('Add solution to editor')} title={t('Add solution to editor')}><Plus size={17} /></button>
          </div>
          <SolutionLinks version={version} />
        </article>;
      })}
    </div>
  </section>;
}
