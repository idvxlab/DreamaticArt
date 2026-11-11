import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FileImage, Share2, Upload } from "lucide-react";
import { useI18n } from "../i18n";
import { downloadPortfolio, downloadProject, getHtmlPreview, solutionFileUrl, type SolutionVersion } from "../api";
import { usePublication } from "../publication-state";
import { assetUrl } from "../asset-url";
import { PublishDialog } from "./PublishDialog";
import type { RunView } from "../types";

export function Showcase({ run, entry, version, finalVersionId, selectionError, selectingFinal, versionUnavailable, onSelectFinal, onRetrySelection }: {
  run?: RunView; entry?: string; version?: SolutionVersion; finalVersionId?: string | null;
  selectionError?: string; selectingFinal?: boolean; versionUnavailable: boolean;
  onSelectFinal: (version: SolutionVersion) => void; onRetrySelection: () => void;
}) {
  const { t } = useI18n();
  const previewRequest = useRef(0);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewMode, setPreviewMode] = useState(false);
  const [previewPages, setPreviewPages] = useState<Array<{ path: string; url: string }>>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const publication = usePublication(run?.id);
  const isFinal = Boolean(version && finalVersionId === version.id);
  const expectedVersionId = version?.id ?? null;
  const canPublishVersion = finalVersionId === expectedVersionId && !selectingFinal;
  const publishedLink = !publication.error && publication.status?.published && !publication.status.inProgress && (publication.status.versionId ?? null) === expectedVersionId ? publication.status.receipt?.previewUrl : undefined;
  const [shareMessage, setShareMessage] = useState<string>();
  const [shareMessageFading, setShareMessageFading] = useState(false);
  const [shareNotice, setShareNotice] = useState(0);
  useEffect(() => {
    if (!shareMessage) return;
    setShareMessageFading(false);
    const fade = setTimeout(() => setShareMessageFading(true), 4000);
    const dismiss = setTimeout(() => setShareMessage(undefined), 4400);
    return () => { clearTimeout(fade); clearTimeout(dismiss); };
  }, [shareMessage, shareNotice]);
  useEffect(() => { setShareMessage(undefined); }, [run?.id, publishOpen]);
  async function shareProject() {
    if (!publishedLink) return;
    setShareMessageFading(false); setShareNotice(value => value + 1);
    const desktop = (window as Window & { dreamaticDesktop?: { copyPublicationLink: (url: string) => Promise<void> } }).dreamaticDesktop;
    // Start clipboard writing before opening the browser so web retains focus
    // and both operations begin within the original click gesture.
    const copy = desktop ? desktop.copyPublicationLink(publishedLink) : navigator.clipboard?.writeText(publishedLink) ?? Promise.reject(new Error("Clipboard unavailable"));
    window.open(publishedLink, "_blank", "noopener,noreferrer");
    try { await copy; setShareMessage("Published project link copied"); }
    catch { setShareMessage("Could not copy the link. Please try again."); }
  }

  const [exporting, setExporting] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [pdfResult, setPdfResult] = useState<Awaited<ReturnType<typeof downloadPortfolio>>>();
  const [exportError, setExportError] = useState<string>();
  useEffect(() => {
    // Invalidate in-flight requests when switching projects or rebuilding.
    previewRequest.current++;
    setPublishOpen(false);
    setPreviewUrl(undefined);
    setPreviewError(undefined);
    setPreviewPages([]);
    setPreviewMode(false);
    setExportError(undefined);
    setPdfResult(undefined);

  }, [run?.id, run?.presentation?.entry, run?.presentation?.mode, run?.stages.build, version?.id]);
  useEffect(() => () => { previewRequest.current++; }, []);

  async function openHtml(path?: string) {
    if (!run || run.stages.build !== "completed") return;
    const entry = path?.startsWith(`runs/${run.id}/`) ? path.slice(`runs/${run.id}/`.length) : path;
    const request = ++previewRequest.current;
    setExportError(undefined);
    setPreviewMode(true); setPreviewUrl(undefined); setPreviewError(undefined); setPreviewPages([]);
    try {
      const preview = await getHtmlPreview(run.id, entry);
      if (request !== previewRequest.current) return;
      setPreviewUrl(preview.url); setPreviewPages(preview.entries);
    } catch (error) {
      if (request === previewRequest.current) setPreviewError(error instanceof Error ? error.message : String(error));
    }
  }
  async function exportProject() {
    if (!run || exporting) return;
    setExporting(true); setExportError(undefined);
    const runId = run.id;
    const request = previewRequest.current;
    try { await downloadProject(runId, version?.id); }
    catch (error) { if (request === previewRequest.current) setExportError(error instanceof Error ? error.message : String(error)); }
    finally { setExporting(false); }
  }
  async function exportPdf() {
    if (!run || pdfExporting) return;
    const request = previewRequest.current;
    setPdfExporting(true); setExportError(undefined); setPdfResult(undefined);
    try { const result = await downloadPortfolio(run.id); if (request === previewRequest.current) setPdfResult(result); }
    catch (error) { if (request === previewRequest.current) setExportError(error instanceof Error ? error.message : String(error)); }
    finally { setPdfExporting(false); }
  }
  const showcaseAvailable = run?.presentation?.mode === "html" ? run.stages.build === "completed" : Boolean(run?.showcasePath);

  const htmlPublicationBlocked = !version && !run?.hasImageDeliverables && (run?.presentation?.mode === "html" || Boolean(run?.htmlEntries?.length));
  const interactive = !version && (run?.presentation?.mode === "html" || previewMode);
  const awaitingSelection = !version && !entry && Boolean(run && (showcaseAvailable || finalVersionId) && finalVersionId !== null);
  const showcaseUrl = version ? solutionFileUrl(version, version.showcasePath)
    : awaitingSelection ? undefined : interactive ? previewUrl : run?.showcasePath ? assetUrl(run.showcasePath) : undefined;

  useEffect(() => {
    if (!version && (run?.presentation?.mode === "html" || entry)) void openHtml(entry ?? run?.presentation?.entry);
    else { setPreviewMode(false); void publication.refresh(); }
  }, [run?.id, run?.presentation?.entry, run?.presentation?.mode, run?.stages.build, entry, version?.id]);
  return <main className="canvas-shell">
    {showcaseAvailable || entry || version || finalVersionId ? (
        <section className={version ? "showcase-view solution-preview" : "showcase-view"}>
          {version && <div className="preview-solution-heading"><strong>{version.title}</strong><small>{t(isFinal ? 'Final solution' : 'Solution version')}</small></div>}
          {selectionError && !awaitingSelection && <p className="preview-export-error" role="alert">{t(selectionError)}</p>}
          {interactive && previewPages.length > 1 && <div className="preview-pages"><label>{t("Page")} <select aria-label={t("Prototype page")} value={previewUrl ?? ""} onChange={(event) => setPreviewUrl(event.target.value)}>{previewPages.map((page) => <option key={page.path} value={page.url}>{page.path.split("/").at(-1)}</option>)}</select></label></div>}
          {showcaseUrl ? !interactive ? <iframe title={`${version?.title ?? run?.title ?? "Dreamatic · Art"} preview`} src={showcaseUrl} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" /> : <iframe className="prototype-frame" style={{ width: "100%" }} title={`${run?.title ?? "Dreamatic · Art"} prototype`} src={showcaseUrl} sandbox="allow-scripts allow-downloads" /> : <div className="prototype-loading">
            {awaitingSelection ? <><p role={selectionError || versionUnavailable ? "alert" : "status"}>{t(selectionError ?? (versionUnavailable ? "The final solution is unavailable." : "Loading final solution…"))}</p>{(selectionError || versionUnavailable) && <button onClick={onRetrySelection}>{t("Retry preview")}</button>}</>
              : <><p role={previewError ? "alert" : "status"}>{previewError ?? t("Preparing interactive preview…")}</p>{previewError && <button onClick={() => void openHtml(entry ?? run?.presentation?.entry)}>{t("Retry preview")}</button>}</>}
          </div>}
          {showcaseUrl && <div className="preview-actions"><a href={showcaseUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {t("Open")}</a><button disabled={exporting || run?.stages.build !== "completed"} onClick={() => void exportProject()}><Download size={14} /> {exporting ? t("Exporting…") : t("Export")}</button>{!version && run?.presentation?.mode !== "html" && <button disabled={pdfExporting || run?.stages.build !== "completed"} onClick={() => void exportPdf()}><Download size={14} /> {pdfExporting ? t("Generating PDF…") : t("Portfolio PDF")}</button>}{version && !isFinal && <button disabled={selectingFinal} onClick={() => onSelectFinal(version)}>{t("Set as final")}</button>}<button title={htmlPublicationBlocked ? t("HTML UX/UI projects cannot currently be published to the official Gallery") : undefined} disabled={!canPublishVersion || htmlPublicationBlocked || exporting || run?.stages.build !== "completed"} onClick={() => setPublishOpen(true)}><Upload size={14} /> {t("Publish")}</button><button disabled={!publishedLink || exporting} title={!publishedLink ? t("Publish this project before sharing") : t("Copy and open published project")} onClick={() => void shareProject()}><Share2 size={14} /> {t("Share")}</button></div>}
          {htmlPublicationBlocked && <small className="preview-model-credit">{t("HTML UX/UI projects cannot currently be published to the official Gallery")}</small>}
          <small className="preview-model-credit">{t("Reasoning models")}: {[...new Set(run?.modelUsage?.reasoning.map(item => item.model) ?? [])].join(" · ") || t("Not recorded")}<br />{t("Generation models")}: {[...new Set(run?.modelUsage?.generation.map(item => item.model) ?? [])].join(" · ") || t("Not recorded")}</small>
          {shareMessage && <p className={`preview-share-message${shareMessageFading ? " fading" : ""}`} role="status">{t(shareMessage)}</p>}
          {pdfResult && <p className="preview-pdf-result" role="status"><a href={assetUrl(pdfResult.path)} target="_blank" rel="noreferrer">{t("Open PDF")}</a> · {pdfResult.pages} {t("pages")} · {(pdfResult.bytes / 1048576).toFixed(1)} MB{pdfResult.warnings.map((warning, i) => <span key={i}><br />{warning}</span>)}</p>}
          {exportError && <p className="preview-export-error" role="alert">{exportError}</p>}
        </section>
    ) : <section className="empty-canvas"><div className="empty-orbit"><div><FileImage size={28} /></div></div><p className="eyebrow">{t("Preview")}</p><h1>{t("No works to preview yet")}</h1><p>{t("Generated works will appear here when they are ready.")}</p></section>}
    {publishOpen && run && canPublishVersion && !htmlPublicationBlocked && <PublishDialog key={`${run.id}:${expectedVersionId}`} runId={run.id} title={version?.title ?? run.title} versionId={expectedVersionId} onClose={() => setPublishOpen(false)} />}
  </main>;
}
