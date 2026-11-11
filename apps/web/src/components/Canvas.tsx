import { PROMPT_MIN_SIZE, canvasConnectionIssue, normalizeCanvasEdges, validCanvasConnection } from '@dreamatic/project-data/canvas-graph';
import { useCanvasHistory } from '../use-canvas-history';
import { ExternalLink, Flag, Grid3X3, Grip, Hand, LayoutGrid, Minus, MousePointer2, Plus, Scan, Trash2, MessageSquarePlus, LoaderCircle, Undo2, Redo2, MessageSquareText, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { getCanvasState, projectFileUrl, listEditorTasks, submitEditorTask, editorTaskAction, type EditorTask } from '../api';
import { listSolutionTasks, solutionTaskAction, submitSolutionTask, solutionFileUrl, type SolutionTask, type SolutionVersion } from '../api';
import { MaterialPrompt, materialTargets } from './MaterialPrompt';
import { PromptComposer, PromptDialogue } from './PromptDialogue';
import { promptCommand } from '../prompt-commands';
import { SolutionPrompt, solutionPromptOptions } from './SolutionPrompt';
import { MediaRename } from './MediaRename';
import { assetUrl } from '../asset-url';
import { CANVAS_MEDIA_MIME, SOLUTION_MIME, creativeCanvasElements, draggedMedia, mediaKind } from '../canvas-media';
import { useCanvasSave, waitForCanvasWrites } from '../use-canvas-save';
import type { CanvasElementState, CanvasState, ProjectFile, RunView } from '../types';

interface CanvasProps {
  files: ProjectFile[];
  run?: RunView;
  visible: boolean;
  addRequest?: { fileId: string; nonce: string };
  onSelectFile: (file: ProjectFile) => void;
  versions?: SolutionVersion[];
  finalVersionId?: string | null;
  selectingFinal?: boolean;
  onSelectFinal: (version: SolutionVersion) => void;
  onPreviewSolution: (version: SolutionVersion) => void;
  solutionAdd?: { versionId: string; nonce: string };
  onVersionsChanged?: () => void;
  onRenamed?: () => void;
  onOpenPreview?: (path: string) => void;
}
type Camera = CanvasState['camera'];
type Gesture =
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; camera: Camera }
  | { kind: 'move'; pointerId: number; startX: number; startY: number; positions: Map<string, { x: number; y: number }> }
  | { kind: 'select'; pointerId: number; startX: number; startY: number; initialIds: string[] }
  | { kind: 'resize'; pointerId: number; startX: number; startY: number; id: string; width: number; height: number };
const DEFAULT_CAMERA: Camera = { x: 72, y: 72, zoom: .78 };
function bounds(elements: CanvasElementState[]) {
  if (!elements.length) return { x: 0, y: 0, width: 1000, height: 700 };
  const x = Math.min(...elements.map(item => item.x)), y = Math.min(...elements.map(item => item.y));
  return { x, y, width: Math.max(1, ...elements.map(item => item.x + item.width - x)), height: Math.max(1, ...elements.map(item => item.y + item.height - y)) };
}

export function Canvas({ files, run, visible, addRequest, onSelectFile, onOpenPreview, onRenamed, versions = [], solutionAdd, onVersionsChanged, finalVersionId, selectingFinal, onSelectFinal, onPreviewSolution }: CanvasProps) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const handledAdd = useRef<string | undefined>(undefined);
  const measured = useRef(new Set<string>());
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const history = useCanvasHistory({ camera: DEFAULT_CAMERA, elements: [], edges: [] });
  const { camera, elements, edges, setCamera, setElements, setEdges } = history;
  const historyRef = useRef(history); historyRef.current = history;
  const [handledTaskIds, setHandledTaskIds] = useState<string[]>([]);
  const handledTasks = useRef(new Set<string>());
  const [solutionTasks, setSolutionTasks] = useState<SolutionTask[]>([]);
  const versionsRef = useRef(versions); versionsRef.current = versions;
  const refreshVersionsRef = useRef(onVersionsChanged); refreshVersionsRef.current = onVersionsChanged;
  const [tasks, setTasks] = useState<EditorTask[]>([]);
  const [resultFiles, setResultFiles] = useState<ProjectFile[]>([]);
  const currentFiles = [...files, ...resultFiles.filter(file => !files.some(item => item.id === file.id))];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number }>();
  const [link, setLink] = useState<{ id: string; side: 'left' | 'right'; x: number; y: number; edgeId?: string }>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const submitting = useRef(new Set<string>());
  const [guides, setGuides] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dreamatic-canvas-guides') ?? 'null');
      return { dots: typeof saved?.dots === 'boolean' ? saved.dots : true, grid: typeof saved?.grid === 'boolean' ? saved.grid : false };
    } catch { return { dots: true, grid: false }; }
  });
  useEffect(() => { try { localStorage.setItem('dreamatic-canvas-guides', JSON.stringify(guides)); } catch { /* Controls still work without local storage. */ } }, [guides]);
  const guideBackground = useMemo(() => {
    const layers: string[] = [], sizes: string[] = [], positions: string[] = [];
    const dotSpacing = 18 * camera.zoom, gridSpacing = 72 * camera.zoom;
    if (guides.dots) {
      const radius = Math.max(.5, camera.zoom);
      layers.push(`radial-gradient(circle, #b8bcb4 ${radius}px, transparent ${radius}px)`);
      sizes.push(`${dotSpacing}px ${dotSpacing}px`);
      positions.push(`${camera.x - dotSpacing / 2}px ${camera.y - dotSpacing / 2}px`);
    }
    if (guides.grid) {
      const lineWidth = Math.max(.5, .75 * camera.zoom);
      layers.push(`linear-gradient(to right, #d2d6ce ${lineWidth}px, transparent ${lineWidth}px)`, `linear-gradient(to bottom, #d2d6ce ${lineWidth}px, transparent ${lineWidth}px)`);
      sizes.push(`${gridSpacing}px ${gridSpacing}px`, `${gridSpacing}px ${gridSpacing}px`);
      positions.push(`${camera.x - lineWidth / 2}px ${camera.y - lineWidth / 2}px`, `${camera.x - lineWidth / 2}px ${camera.y - lineWidth / 2}px`);
    }
    return { backgroundImage: layers.join(', ') || 'none', backgroundSize: sizes.join(', ') || 'auto', backgroundPosition: positions.join(', ') || '0 0' };
  }, [camera, guides]);
  const [, setSelectedId] = useState<string>();
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!run) return;
    let disposed = false;
    setLoadError(false); setReady(false);
    void waitForCanvasWrites(run.id).then(() => getCanvasState(run.id)).then(saved => {
      if (disposed) return;
      const restored = creativeCanvasElements(saved?.elements ?? []);
      measured.current = new Set(restored.filter(item => item.kind === 'image' && item.outputTaskId && item.width === 360 && item.height === 280).map(item => item.id));
      historyRef.current.restore({ elements: restored, camera: saved?.elements.length && !restored.length ? DEFAULT_CAMERA : saved?.camera ?? DEFAULT_CAMERA, edges: normalizeCanvasEdges(restored, saved?.edges) });
      handledTasks.current = new Set(saved?.handledTaskIds ?? []);
      setHandledTaskIds([...handledTasks.current]);
      setSelectedIds([]); setSelectedId(undefined); setTasks([]); setResultFiles([]); setDirty(false);
      setReady(true);
    }).catch(() => { if (!disposed) setLoadError(true); });
    return () => { disposed = true; };
  }, [run?.id, loadAttempt]);
  // A failed restore must never overwrite a historical board with an empty one.
  const state = useMemo<CanvasState | undefined>(() => ready && run ? { version: 1, runId: run.id, updatedAt: new Date().toISOString(), camera, elements, edges, handledTaskIds } : undefined, [camera, elements, edges, handledTaskIds, ready, run?.id]);
  const persistence = useCanvasSave(state, dirty);
  useEffect(() => { if (!visible) { gesture.current = undefined; setSelectionBox(undefined); historyRef.current.end(); setDropActive(false); viewport.current?.querySelectorAll('video').forEach(video => video.pause()); } }, [visible]);
  const mediaFile = (item: CanvasElementState) => currentFiles.find(file => file.id === item.fileId || (file.path && item.assetPath === `runs/${run?.id}/${file.path}`));
  function source(item: CanvasElementState) {
    return item.fileId && run ? projectFileUrl(run.id, item.fileId) : item.assetPath ? assetUrl(item.assetPath) : undefined;
  }
  function choose(item: CanvasElementState, multiple = false) {
    setSelectedEdge(undefined);
    setSelectedId(item.id);
    setSelectedIds(current => multiple ? current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id] : [item.id]);
    const file = mediaFile(item); if (file) onSelectFile(file);
  }
  function add(file: ProjectFile, clientX?: number, clientY?: number) {
    const kind = mediaKind(file), rect = viewport.current?.getBoundingClientRect();
    if (!ready || !run || !kind || !rect) return;
    const x = ((clientX ?? rect.left + rect.width / 2) - rect.left - camera.x) / camera.zoom;
    const y = ((clientY ?? rect.top + rect.height / 2) - rect.top - camera.y) / camera.zoom;
    const item: CanvasElementState = {
      id: crypto.randomUUID(), kind, fileId: file.id,
      ...(file.path ? { assetPath: `runs/${run.id}/${file.path}` } : {}),
      text: file.title, role: file.group, x, y, width: 360, height: 280,
    };
    measured.current.add(item.id);
    setElements(current => [...current, item]); setDirty(true); setTool('select'); choose(item);
    setNotice(undefined); viewport.current?.focus();
  }
  useEffect(() => {
    if (!addRequest || !ready || !visible || handledAdd.current === addRequest.nonce) return;
    const file = files.find(file => file.id === addRequest.fileId && file.category === 'assets');
    if (file) { handledAdd.current = addRequest.nonce; add(file); }
  }, [addRequest, ready, visible, files]);
  function addSolution(version: SolutionVersion, clientX?: number, clientY?: number) {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || !ready) return;
    const item: CanvasElementState = {
      id: crypto.randomUUID(), kind: 'solution', versionId: version.id, text: version.title,
      x: ((clientX ?? rect.left + rect.width / 2) - rect.left - camera.x) / camera.zoom - 160,
      y: ((clientY ?? rect.top + rect.height / 2) - rect.top - camera.y) / camera.zoom - 100,
      width: 320, height: 260,
    };
    history.begin(); setElements(current => [...current, item]); history.end();
    choose(item); setDirty(true);
  }
  const handledSolutionAdd = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible || !ready || !solutionAdd || handledSolutionAdd.current === solutionAdd.nonce) return;
    const version = versions.find(entry => entry.id === solutionAdd.versionId);
    if (!version) return;
    handledSolutionAdd.current = solutionAdd.nonce;
    addSolution(version);
  }, [solutionAdd, ready, visible, versions]);

  function drop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDropActive(false);
    const payload = event.dataTransfer.getData(SOLUTION_MIME);
    if (payload) {
      try {
        const data = JSON.parse(payload);
        const version = versions.find(entry => entry.runId === run?.id && entry.runId === data.runId && entry.id === data.versionId);
        if (version) addSolution(version, event.clientX, event.clientY);
      } catch { /* Ignore malformed drag payloads. */ }
      return;
    }
    const file = run ? draggedMedia(event.dataTransfer.getData(CANVAS_MEDIA_MIME), run.id, files) : undefined;
    if (!file || !ready) { setNotice('Only images and videos from this project can be added to the canvas.'); return; }
    add(file, event.clientX, event.clientY);
  }
  function beginBackground(event: React.PointerEvent<HTMLDivElement>) {
    if (!ready || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, video, .prompt-dialog-body, .prompt-composer')) return;
    if (tool !== 'hand' && event.target !== event.currentTarget && !(event.target instanceof Element && event.target.closest('.canvas-empty-state'))) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'hand') {
      history.begin();
      gesture.current = { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, camera };
    } else {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left - camera.x) / camera.zoom, y = (event.clientY - rect.top - camera.y) / camera.zoom;
      const initialIds = event.shiftKey ? selectedIds : [];
      setSelectedIds(initialIds); setSelectedId(undefined); setSelectedEdge(undefined);
      setSelectionBox({ x, y, width: 0, height: 0 });
      gesture.current = { kind: 'select', pointerId: event.pointerId, startX: x, startY: y, initialIds };
    }
  }
  function beginElement(event: React.PointerEvent<HTMLElement>, item: CanvasElementState, resize = false) {
    if (event.button !== 0 || !ready) return;
    if (event.target instanceof Element && event.target.closest('textarea, input, select, a, button:not(.canvas-resize-handle), video, .prompt-dialog-body, .prompt-composer')) return;
    if (tool === 'hand' && !resize) return;
    event.stopPropagation(); event.preventDefault(); viewport.current?.focus();
    if (event.shiftKey && !resize) { choose(item, true); return; }
    // Keep the current selection when dragging one of its members.
    const movingIds = selectedIds.includes(item.id) ? selectedIds : [item.id];
    if (!selectedIds.includes(item.id)) choose(item);
    setSelectedEdge(undefined);
    event.currentTarget.setPointerCapture(event.pointerId);
    history.begin();
    gesture.current = resize ? { kind: 'resize', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, id: item.id, width: item.width, height: item.height }
      : { kind: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, positions: new Map(elements.filter(node => movingIds.includes(node.id)).map(node => [node.id, { x: node.x, y: node.y }])) };
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (link) { const rect = viewport.current?.getBoundingClientRect(); if (rect) setLink({ ...link, x: (event.clientX - rect.left - camera.x) / camera.zoom, y: (event.clientY - rect.top - camera.y) / camera.zoom }); return; }
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.kind === 'select') {
      const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
      const x = (event.clientX - rect.left - camera.x) / camera.zoom, y = (event.clientY - rect.top - camera.y) / camera.zoom;
      const box = { x: Math.min(x, active.startX), y: Math.min(y, active.startY), width: Math.abs(x - active.startX), height: Math.abs(y - active.startY) };
      setSelectionBox(box);
      const hits = elements.filter(item => item.x < box.x + box.width && item.x + item.width > box.x && item.y < box.y + box.height && item.y + item.height > box.y).map(item => item.id);
      setSelectedIds([...new Set([...active.initialIds, ...hits])]);
      return;
    }
    const dx = (event.clientX - active.startX) / camera.zoom, dy = (event.clientY - active.startY) / camera.zoom;
    if (active.kind === 'pan') setCamera({ ...active.camera, x: active.camera.x + event.clientX - active.startX, y: active.camera.y + event.clientY - active.startY });
    else if (active.kind === 'move') setElements(current => current.map(item => { const origin = active.positions.get(item.id); return origin ? { ...item, x: origin.x + dx, y: origin.y + dy } : item; }));
    else {
      measured.current.delete(active.id);
      const resizing = elements.find(item => item.id === active.id);
      const minimum = (resizing?.kind === 'prompt' || resizing?.kind === 'solution-prompt') ? PROMPT_MIN_SIZE : { width: 120, height: 100 };
      if (resizing?.kind === 'prompt' || resizing?.kind === 'solution-prompt') {
        const width = Math.min(2400, Math.max(minimum.width, active.width + dx));
        const height = Math.min(2400, Math.max(minimum.height, active.height + dy));
        setElements(current => current.map(item => item.id === active.id ? { ...item, width, height } : item));
      } else {
        const scale = Math.max(minimum.width / active.width, minimum.height / active.height, Math.min(2400 / active.width, 2400 / active.height, 1 + (dx * active.width + dy * active.height) / (active.width ** 2 + active.height ** 2)));
        setElements(current => current.map(item => item.id === active.id ? { ...item, width: active.width * scale, height: active.height * scale } : item));
      }
    }
    setDirty(true);
  }
  function endGesture(event: React.PointerEvent<HTMLElement>) {
    if (link) { const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-port-node]'); if (target && target.dataset.portSide !== link.side) connect(link.side === 'right' ? link.id : target.dataset.portNode!, link.side === 'right' ? target.dataset.portNode! : link.id, link.edgeId); setLink(undefined); }
    if (gesture.current?.pointerId === event.pointerId) { const active = gesture.current; gesture.current = undefined; setSelectionBox(undefined); if (active.kind !== 'select') history.end(); }
  }
  function removeElement(id: string) {
    history.begin();
    setElements(current => current.filter(item => item.id !== id));
    setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id));
    history.end();
    setSelectedIds(current => current.filter(value => value !== id));
    setSelectedId(current => current === id ? undefined : current);
    setDirty(true);
  }
  function removeSelected() {
    if (selectedEdge) { setEdges(current => current.filter(edge => edge.id !== selectedEdge)); setSelectedEdge(undefined); setDirty(true); return; }
    history.begin();
    for (const id of selectedIds) { setElements(current => current.filter(item => item.id !== id)); setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id)); }
    history.end(); setSelectedIds([]); setSelectedId(undefined); setDirty(true);
  }
  function metadata(item: CanvasElementState, width: number, height: number, media: HTMLImageElement | HTMLVideoElement) {
    if (!measured.current.has(item.id) || !width || !height) return;
    measured.current.delete(item.id);
    if (item.width !== 360 || item.height !== 280) return;
    const card = media.closest<HTMLElement>('.canvas-media');
    if (!card) return;
    const style = getComputedStyle(card);
    const horizontalInset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const verticalInset = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const chromeHeight = verticalInset + (card.querySelector('figcaption')?.offsetHeight ?? 48);
    const cardHeight = Math.max(120, Math.min(1200, (item.width - horizontalInset) * height / width + chromeHeight));
    // Metadata refines the insertion snapshot rather than creating an extra undo operation.
    history.amendElements(current => current.map(entry => entry.id === item.id && entry.width === 360 && entry.height === 280 ? { ...entry, height: cardHeight } : entry));
    setDirty(true);
  }
  const zoomAt = useCallback((nextZoom: number, clientX?: number, clientY?: number) => {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect || !ready) return;
    const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left, anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    historyRef.current.begin();
    clearTimeout(zoomTimer.current);
    zoomTimer.current = setTimeout(() => historyRef.current.end(), 220);
    setCamera(current => { const zoom = Math.max(.2, Math.min(2.4, nextZoom)); return { zoom, x: anchorX - (anchorX - current.x) / current.zoom * zoom, y: anchorY - (anchorY - current.y) / current.zoom * zoom }; });
    setDirty(true);
  }, [ready]);
  function fit() {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect || !ready) return;
    const box = bounds(elements), zoom = Math.max(.2, Math.min(1.25, (rect.width - 84) / box.width, (rect.height - 84) / box.height));
    history.begin();
    setCamera({ zoom, x: (rect.width - box.width * zoom) / 2 - box.x * zoom, y: (rect.height - box.height * zoom) / 2 - box.y * zoom }); history.end(); setDirty(true);
  }
  function reflow() {
    if (!ready) return;
    // Arrange existing instances only. Duplicate media and custom elements remain intact.
    const columnWidth = Math.max(360, ...elements.map(item => item.width)) + 24;
    let y = 40;
    const positions = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < elements.length; i += 3) {
      const row = elements.slice(i, i + 3);
      row.forEach((item, col) => positions.set(item.id, { x: 40 + col * columnWidth, y }));
      y += Math.max(...row.map(item => item.height)) + 40;
    }
    history.begin(); setElements(current => current.map(item => ({ ...item, ...positions.get(item.id)! }))); setCamera(DEFAULT_CAMERA); history.end(); setDirty(true);
  }
  function connect(source: string, target: string, edgeId?: string) {
    const board = history.current.current;
    const issue = canvasConnectionIssue(board.elements, board.edges.filter(edge => edge.id !== edgeId), source, target);
    if (issue) {
      setNotice({ incompatible: 'Connect an image or solution to a prompt.', duplicate: 'These cards are already connected.', cycle: 'This connection would create a loop.' }[issue]);
      return;
    }
    setNotice(undefined);
    setEdges(current => [...current.filter(edge => edge.id !== edgeId), { id: edgeId ?? crypto.randomUUID(), source, target }]); setDirty(true);
  }
  function ports(item: CanvasElementState) {
    return (['left', 'right'] as const).map(side => <button key={side} className={`canvas-port port-${side}`} data-port-node={item.id} data-port-side={side} aria-label={`${t(side === 'left' ? 'Input port' : 'Output port')} ${item.text ?? item.id}`} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); viewport.current?.setPointerCapture(event.pointerId); setLink({ id: item.id, side, x: item.x + (side === 'right' ? item.width : 0), y: item.y + item.height / 2 }); }} />);
  }
  function incoming(item: CanvasElementState) {
    return edges.filter(edge => edge.target === item.id).flatMap(edge => {
      const node = elements.find(entry => entry.id === edge.source);
      return node ? [node] : [];
    });
  }
  function createPrompt() {
    const inputs = elements.filter(node => selectedIds.includes(node.id) && (node.kind === 'image' || node.kind === 'video' || node.kind === 'solution'));
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const item: CanvasElementState = {
      id: crypto.randomUUID(), kind: 'prompt', text: '',
      x: inputs.length ? Math.max(...inputs.map(node => node.x + node.width)) + 100 : (rect.width / 2 - camera.x) / camera.zoom - 185,
      y: inputs.length ? Math.min(...inputs.map(node => node.y)) : (rect.height / 2 - camera.y) / camera.zoom - 160,
      width: 410, height: 420,
    };
    history.begin(); setElements(current => [...current, item]);
    setEdges(current => [...current, ...inputs.map(input => ({ id: crypto.randomUUID(), source: input.id, target: item.id }))]);
    history.end(); setSelectedIds([item.id]); setDirty(true); setTool('select'); setNotice(undefined);
  }
  function solutionInputs(item: CanvasElementState) {
    const ids = [...new Set(edges.filter(edge => edge.target === item.id).map(edge => elements.find(node => node.id === edge.source)?.versionId))];
    return ids.flatMap(id => {
      const version = versions.find(entry => entry.id === id);
      return version ? [version] : [];
    });
  }
  function updateSolutionPrompt(item: CanvasElementState, fields: Partial<CanvasElementState>) {
    setElements(current => current.map(node => node.id === item.id ? { ...node, ...fields } : node));
    setDirty(true);
  }
  function moveSolutionInput(item: CanvasElementState, index: number) {
    const sources = solutionInputs(item);
    const find = (versionId: string) => edges.findIndex(edge => edge.target === item.id && elements.some(node => node.id === edge.source && node.versionId === versionId));
    const first = find(sources[index - 1]!.id), second = find(sources[index]!.id);
    if (first < 0 || second < 0) return;
    const next = [...edges];
    [next[first], next[second]] = [next[second]!, next[first]!];
    history.begin(); setEdges(next); history.end(); setDirty(true);
  }
  async function executeSolution(item: CanvasElementState) {
    if (!run || submitting.current.has(item.id)) return;
    const id = crypto.randomUUID();
    const sources = solutionInputs(item);
    const { operation, outputCount, replacement, canRun } = solutionPromptOptions(item, sources);
    const command = promptCommand(item.text ?? '');
    if (!canRun || !command.prompt || command.error || incoming(item).some(node => node.kind === 'image')) return;
    submitting.current.add(item.id);
    updateSolutionPrompt(item, { taskId: id });
    try {
      const task = await submitSolutionTask(run.id, {
        id, parentIds: sources.map(version => version.id), prompt: command.prompt, originalPrompt: item.text?.trim(), operation,
        outputCount: operation === 'split' ? outputCount : 1,
        ...(operation === 'replace' && replacement ? { replacement } : {}),
        sourceNotes: sources.map(version => item.sourceNotes?.[version.id] ?? ''), promptNodeId: item.id,
      });
      setSolutionTasks(current => [...current.filter(entry => entry.id !== id), task]);
      updateSolutionPrompt(item, { text: '' });
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not start solution edit.'); }
    finally { submitting.current.delete(item.id); }
  }
  async function changeSolutionTask(id: string, action: 'cancel' | 'retry') {
    if (!run) return;
    try {
      const task = await solutionTaskAction(run.id, id, action);
      setSolutionTasks(current => [...current.filter(entry => entry.id !== id), task]);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not update solution task.'); }
  }
  const hasPrompts = elements.some(item => item.kind === 'prompt');
  useEffect(() => {
    if (!ready || !run || !hasPrompts || !visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(runId: string) {
      try {
        const tasks = await listSolutionTasks(runId);
        if (disposed) return;
        setSolutionTasks(tasks);
        for (const task of tasks) {
          if (task.status !== 'succeeded' || handledTasks.current.has(task.id)) continue;
          const available = task.outputIds.map(id => versionsRef.current.find(version => version.id === id));
          if (available.some(version => !version)) { refreshVersionsRef.current?.(); continue; }
          handledTasks.current.add(task.id); setHandledTaskIds([...handledTasks.current]); setDirty(true);
          const h = historyRef.current, board = h.current.current;
          const prompt = board.elements.find(node => node.kind === 'prompt' && node.id === task.promptNodeId);
          if (!prompt || (prompt.taskId && prompt.taskId !== task.id || !prompt.taskId && tasks.find(entry => entry.promptNodeId === prompt.id)?.id !== task.id)) continue;
          const outputs: CanvasElementState[] = available.flatMap((version, index) => {
            const id = `solution-output-${version!.id}`;
            return board.elements.some(node => node.id === id) ? [] : [{
              id, kind: 'solution', versionId: version!.id, text: version!.title, outputTaskId: task.id,
              x: prompt.x + prompt.width + 100, y: prompt.y + index * 295, width: 320, height: 260,
            }];
          });
          h.begin();
          h.setElements(current => [...current, ...outputs]);
          h.setEdges(current => [...current, ...outputs.map(output => ({ id: `edge-${output.id}`, source: prompt.id, target: output.id }))]);
          h.end();
        }
      } catch { /* Keep working on the board while the task service is unavailable. */ }
      if (!disposed) timer = setTimeout(() => void poll(runId), 1500);
    }
    void poll(run.id);
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready, run?.id, hasPrompts, visible]);
  async function submitPrompt(item: CanvasElementState) {
    if (!run || submitting.current.has(item.id)) return;
    const command = promptCommand(item.text ?? '');
    if (command.solutionOnly || !command.prompt || command.error) return;
    const inputs = history.current.current.edges.filter(edge => edge.target === item.id).map(edge => elements.find(node => node.id === edge.source)).filter((node): node is CanvasElementState => Boolean(node?.kind === 'image')).map(node => ({ ...node, fileId: node.fileId ?? mediaFile(node)?.id })).filter(node => Boolean(node.fileId));
    if (incoming(item).some(node => node.kind === 'solution')) return;
    if (!inputs.length) { setNotice('Connect at least one project image to this prompt.'); return; }
    const id = crypto.randomUUID(); submitting.current.add(item.id);
    setElements(current => current.map(node => node.id === item.id ? { ...node, taskId: id } : node)); setDirty(true);
    setTasks(current => [...current, { id, source: 'canvas', prompt: command.prompt, originalPrompt: item.text?.trim(), inputIds: inputs.map(node => node.fileId!), status: 'submitted', attempt: 1, createdAt: new Date().toISOString(), promptNodeId: item.id }]);
    try {
      const task = await submitEditorTask(run.id, { id, source: 'canvas', prompt: command.prompt, originalPrompt: item.text?.trim(), inputIds: [...new Set(inputs.map(node => node.fileId!))], promptNodeId: item.id, upstream: inputs.map(node => ({ nodeId: node.id, fileId: node.fileId!, ...(node.outputTaskId ? { taskId: node.outputTaskId } : {}) })) });
      setTasks(current => [...current.filter(value => value.id !== id), task]);
      updateSolutionPrompt(item, { text: '' });
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Editor submission failed'); setTasks(current => current.map(task => task.id === id ? { ...task, status: 'failed', error: 'Submission failed. Refresh to check before retrying.' } : task)); }
    finally { submitting.current.delete(item.id); }
  }
  async function taskAction(id: string, action: 'cancel' | 'retry') {
    if (!run) return;
    try { const task = await editorTaskAction(run.id, id, action); setTasks(current => [...current.filter(item => item.id !== id), task]); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Editor request failed'); }
  }
  useEffect(() => {
    if (!ready || !run) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const received = await listEditorTasks(run.id); if (disposed) return;
        setTasks(current => [...received, ...current.filter(task => !received.some(item => item.id === task.id) && submitting.current.size > 0)]);
        for (const task of received) {
          if (task.source !== 'canvas' || !task.promptNodeId || task.status !== 'succeeded' || !task.output || task.outputAvailable === false || handledTasks.current.has(task.id)) continue;
          handledTasks.current.add(task.id); setHandledTaskIds([...handledTasks.current]); setDirty(true);
          setResultFiles(current => [...current.filter(file => file.id !== task.output!.id), task.output!]);
          onRenamed?.();
          const h = historyRef.current, board = h.current.current;
          const prompt = board.elements.find(node => node.kind === 'prompt' && node.id === task.promptNodeId && (node.taskId === task.id || (!node.taskId && received.find(entry => entry.promptNodeId === node.id)?.id === task.id)));
          if (!prompt || board.elements.some(node => node.outputTaskId === task.id)) continue;
          const output: CanvasElementState = { id: `editor-output-${task.id}`, kind: 'image', fileId: task.output.id, outputTaskId: task.id, text: task.output.title, x: prompt.x + prompt.width + 100, y: prompt.y, width: 360, height: 280 };
          if (!validCanvasConnection([...board.elements, output], board.edges, prompt.id, output.id)) continue;
          measured.current.add(output.id);
          h.begin(); h.setElements([...board.elements, output]); h.setEdges([...board.edges, { id: `editor-edge-${task.id}`, source: prompt.id, target: output.id }]); h.end();
        }
      } catch { /* Existing boards can still be edited while the task service is unavailable. */ }
      if (!disposed) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready, run?.id]);
  useEffect(() => () => clearTimeout(zoomTimer.current), []);
  function curve(x1: number, y1: number, x2: number, y2: number) { const bend = Math.max(60, Math.abs(x2 - x1) / 2); return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`; }
  return <main className="canvas-shell">
    <div ref={viewport} tabIndex={0} role="region" aria-label={t('Canvas editing area')} style={guideBackground} className={`canvas-viewport tool-${tool}${dropActive ? ' canvas-drop-active' : ''}`} onPointerDown={beginBackground} onPointerMove={move} onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture}
      onWheel={event => { if (event.target instanceof Element && event.target.closest('.canvas-note, .prompt-dialog-body, .canvas-prompt footer, video')) return; if (gesture.current) { event.preventDefault(); return; } event.preventDefault(); zoomAt(camera.zoom * Math.exp(-event.deltaY * .0012), event.clientX, event.clientY); }}
      onDragOver={event => { if (!ready || !event.dataTransfer.types.some(type => type === CANVAS_MEDIA_MIME || type === SOLUTION_MIME)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDrop={drop}
      onKeyDown={event => { if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, video, [contenteditable="true"], .prompt-dialog-body, .prompt-composer')) return; if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? history.redo() : history.undo(); setDirty(true); return; } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); history.redo(); setDirty(true); return; } if (['Delete', 'Backspace'].includes(event.key) && (selectedIds.length || selectedEdge)) { event.preventDefault(); removeSelected(); } }}>
      {!ready && run ? <section className="run-progress canvas-empty-state"><p className="canvas-loading-copy" role={loadError ? 'alert' : 'status'}>{t(loadError ? 'Could not restore the canvas. Retry before editing.' : 'Restoring canvas…')}</p>{loadError && <button onClick={() => setLoadAttempt(value => value + 1)}>{t('Retry')}</button>}</section> : elements.length > 0 ? <div className="canvas-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        <svg className="canvas-connections" aria-label={t('Connections')}>
          {edges.map(edge => { const from = elements.find(item => item.id === edge.source), to = elements.find(item => item.id === edge.target); if (!from || !to) return null; return <path key={edge.id} data-edge-id={edge.id} d={curve(from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2)} className={selectedEdge === edge.id ? 'selected' : ''} role="button" tabIndex={0} aria-label={`${t('Select connection')} ${edge.source} → ${edge.target}`} onPointerDown={event => { event.stopPropagation(); setSelectedEdge(edge.id); setSelectedIds([]); }} onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); setEdges(current => current.filter(item => item.id !== edge.id)); setDirty(true); } }} />; })}
          {link && (() => { const node = elements.find(item => item.id === link.id); return node ? <path className="pending" d={curve(node.x + (link.side === 'right' ? node.width : 0), node.y + node.height / 2, link.x, link.y)} /> : null; })()}
        </svg>
        {selectedEdge && !link && (() => { const edge = edges.find(edge => edge.id === selectedEdge); if (!edge) return null; return (['source', 'target'] as const).map(end => { const node = elements.find(node => node.id === edge[end]); const fixed = elements.find(node => node.id === edge[end === 'source' ? 'target' : 'source']); if (!node || !fixed) return null; return <button key={end} className="canvas-edge-endpoint" aria-label={t(end === 'source' ? 'Reconnect source' : 'Reconnect target')} style={{ left: node.x + (end === 'source' ? node.width : 0) - 7, top: node.y + node.height / 2 - 7 }} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); viewport.current?.setPointerCapture(event.pointerId); setLink({ id: fixed.id, side: end === 'source' ? 'left' : 'right', x: node.x, y: node.y, edgeId: edge.id }); }} />; }); })()}
        {elements.map(item => item.kind === 'group' ? <section key={item.id} data-element-id={item.id} className={`canvas-group-label role-${item.role ?? 'other'} ${selectedIds.includes(item.id) ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}><span>{t(item.text ?? '')}</span><small>{t('Run outputs')}</small></section>
          : (item.kind === 'image' || item.kind === 'video') && source(item) ? <figure key={item.id} data-element-id={item.id} className={`canvas-artboard canvas-media ${selectedIds.includes(item.id) ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}>
            <div>{item.kind === 'video' ? <video src={source(item)} controls preload="metadata" onPointerDown={event => { event.stopPropagation(); choose(item, event.shiftKey); }} onLoadedMetadata={event => metadata(item, event.currentTarget.videoWidth, event.currentTarget.videoHeight, event.currentTarget)} onError={() => setNotice('This media could not be loaded. The original file may be missing or unsupported.')} /> : <img draggable={false} src={source(item)} alt={mediaFile(item)?.title ?? item.text ?? item.assetPath?.split('/').at(-1) ?? ''} onLoad={event => metadata(item, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight, event.currentTarget)} onError={() => setNotice('This media could not be loaded. The original file may be missing or unsupported.')} />}</div>
            {ports(item)}
            <figcaption><span><strong>{mediaFile(item)?.title ?? item.text ?? item.assetPath?.split('/').at(-1)}</strong><small>{t(item.kind === 'video' ? 'Video file' : 'Image file')}</small></span>{run && mediaFile(item) && <MediaRename runId={run.id} file={mediaFile(item)!} onRenamed={onRenamed} onAddResult={file => add(file)} />}<a aria-label={t('Open asset')} href={source(item)} target="_blank" rel="noreferrer" onPointerDown={event => event.stopPropagation()}><ExternalLink size={13} /></a>{item.kind === 'image' && <button type="button" className="canvas-media-delete" aria-label={t('Remove image from canvas')} title={t('Remove image from canvas')} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); removeElement(item.id); }}><Trash2 size={24} /></button>}</figcaption>
            {selectedIds.includes(item.id) && <button className="canvas-resize-handle" aria-label={t('Resize selected media')} onPointerDown={event => beginElement(event, item, true)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); measured.current.delete(item.id); const factor = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? .9 : 1.1; if (item.width * factor >= 120 && item.height * factor >= 100 && Math.max(item.width, item.height) * factor <= 2400) { setElements(current => current.map(entry => entry.id === item.id ? { ...entry, width: entry.width * factor, height: entry.height * factor } : entry)); setDirty(true); } }} />}
          </figure>
          : item.kind === 'solution' ? (() => {
            const version = versions.find(entry => entry.id === item.versionId);
            const isFinal = Boolean(version && version.id === finalVersionId);
            return <figure key={item.id} data-element-id={item.id} className={`canvas-artboard canvas-media canvas-solution ${selectedIds.includes(item.id) ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}>
              <div>{version && <img draggable={false} src={solutionFileUrl(version, version.coverPath)} alt="" />}</div>
              {ports(item)}
              <figcaption><span><strong>{version?.title ?? item.text}</strong><small>{isFinal ? t('Final solution') : version ? `${version.images.length} ${t('Design images')}` : t('Version unavailable')}</small></span>
                {version && <><button type="button" disabled={isFinal || selectingFinal} aria-label={t(isFinal ? 'Final solution' : 'Set as final')} title={t(isFinal ? 'Final solution' : 'Set as final')} onPointerDown={event => event.stopPropagation()} onClick={() => onSelectFinal(version)}><Flag size={15} fill={isFinal ? 'currentColor' : 'none'} /></button>
                  <button type="button" aria-label={t('Open showcase')} title={t('Preview')} onPointerDown={event => event.stopPropagation()} onClick={() => onPreviewSolution(version)}><ExternalLink size={15} /></button></>}
              </figcaption>
            </figure>;
          })()
          : item.kind === 'prompt' ? (() => {
            const inputs = incoming(item);
            const imageInputs = inputs.filter(node => node.kind === 'image');
            const versionInputs = inputs.filter(node => node.kind === 'solution');
            const mediaInputs = inputs.filter(node => node.kind === 'image' || node.kind === 'video');
            const mixed = mediaInputs.length > 0 && versionInputs.length > 0;
            const materialFiles = [...new Map(mediaInputs.flatMap(node => {
              const file = mediaFile(node);
              return file ? [[file.id, file] as const] : [];
            })).values()];
            const invalidMaterial = materialFiles.length !== new Set(mediaInputs.map(node => node.fileId ?? mediaFile(node)?.id ?? node.id)).size ||
              materialFiles.some(file => !/^(png|jpe?g|webp|gif|mp4|webm)$/iu.test(file.kind));
            const sources = solutionInputs(item);
            const missing = versionInputs.some(node => !sources.some(version => version.id === node.versionId));
            const inputFiles = [...new Set(imageInputs.flatMap(node => {
              const id = node.fileId ?? mediaFile(node)?.id;
              return id ? [id] : [];
            }))];
            const imageRunning = (status?: EditorTask['status']) => status === 'submitted' || status === 'running';
            const solutionRunning = (status?: SolutionTask['status']) => status === 'running' || status === 'waiting';
            const imageTask = tasks.find(task => task.id === item.taskId) ?? tasks.find(task => task.promptNodeId === item.id && imageRunning(task.status));
            const solutionTask = solutionTasks.find(task => task.id === item.taskId) ?? solutionTasks.find(task => task.promptNodeId === item.id && (solutionRunning(task.status) || !item.taskId));
            const busy = submitting.current.has(item.id) || imageRunning(imageTask?.status) || solutionRunning(solutionTask?.status);
            const materialVersion = mixed && sources.length === 1 && versionInputs.length === 1 ? sources[0] : undefined;
            const materialMode = item.materialMode ?? 'integrate';
            const materialTarget = materialVersion && materialTargets(materialVersion, materialFiles).find(target => target.id === item.materialTargetId);
            const validSection = materialVersion?.works?.some(work => work.section === item.materialSection);
            const hasSolution = versionInputs.length > 0;
            const command = promptCommand(item.text ?? '');
            const commandError = command.error || (command.solutionOnly && !hasSolution ? 'This command needs a solution input.' :
              command.operation === 'replace' && !command.prompt ? 'Describe how to replace the selected image.' : undefined);
            const { canRun } = solutionPromptOptions(item, sources);
            const canSend = !busy && !missing && (mixed
              ? Boolean(materialVersion && !invalidMaterial && materialFiles.length && materialFiles.length <= 8 && (materialMode === 'integrate' || materialTarget))
              : !commandError && Boolean(command.prompt) && (hasSolution ? canRun : inputFiles.length > 0 && mediaInputs.length === imageInputs.length));
            const task = imageRunning(imageTask?.status) ? imageTask : solutionRunning(solutionTask?.status) ? solutionTask : imageTask ?? solutionTask;
            const transcript = [...tasks.filter(task => task.promptNodeId === item.id || task.id === item.taskId),
              ...solutionTasks.filter(task => task.promptNodeId === item.id || task.id === item.taskId)]
              .sort((first, second) => (first.createdAt ?? '').localeCompare(second.createdAt ?? ''));
            const send = () => {
              if (mixed && materialVersion) {
                if (!run || !canSend || submitting.current.has(item.id)) return;
                const id = crypto.randomUUID();
                submitting.current.add(item.id);
                updateSolutionPrompt(item, { taskId: id });
                void submitSolutionTask(run.id, {
                  id, parentIds: [materialVersion.id], prompt: '', operation: 'revise', outputCount: 1, sourceNotes: [''], promptNodeId: item.id,
                  materialEdit: { mode: materialMode, fileIds: materialFiles.map(file => file.id),
                    ...(materialMode === 'replace' && materialTarget ? { targetId: materialTarget.id } : {}),
                    ...(materialMode === 'integrate' && validSection ? { section: item.materialSection } : {}) },
                }).then(task => {
                  setSolutionTasks(current => [...current.filter(entry => entry.id !== id), task]);
                }).catch(error => setNotice(error instanceof Error ? error.message : 'Could not start solution edit.'))
                  .finally(() => submitting.current.delete(item.id));
              } else if (hasSolution) void executeSolution(item);
              else void submitPrompt(item);
            };
            const action = (value: 'retry' | 'cancel') => {
              if (task && 'parentIds' in task) void changeSolutionTask(task.id, value);
              else if (task) void taskAction(task.id, value);
            };
            const statusLabel = task && 'parentIds' in task && solutionRunning(task.status)
              ? task.status === 'waiting' ? 'Waiting for another solution edit' : task.phase === 'images' ? 'Preparing images' : task.phase === 'showcase' ? 'Composing showcase' : 'Planning revision'
              : task?.status ?? (busy ? 'submitted' : '');
            return <article key={item.id} data-element-id={item.id} className={`canvas-artboard canvas-prompt prompt-dialogue ${hasSolution ? 'canvas-solution-prompt' : ''} ${mixed ? 'canvas-material-prompt' : ''} ${selectedIds.includes(item.id) ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height, minWidth: PROMPT_MIN_SIZE.width, minHeight: PROMPT_MIN_SIZE.height }} onPointerDown={event => beginElement(event, item)}>
              {ports(item)}<header className="agent-header">
                <div><span className="agent-sigil"><MessageSquareText size={15} aria-hidden="true" /></span><strong>{t(mixed ? 'Solution material editor' : 'Prompt')}</strong></div>
                <button aria-label={t('Delete prompt')} onClick={() => removeElement(item.id)}><X size={15} /></button>
              </header>
              <PromptDialogue tasks={transcript} versions={versions} files={currentFiles} runId={run?.id} latestId={task?.id}>
                {!inputs.length && <small>{t('Connect an image or solution to a prompt.')}</small>}
                {mixed && <>
                  {!materialVersion && <small role="status">{t('Connect one solution to edit its materials.')}</small>}
                  {invalidMaterial && <small role="status">{t('Use PNG, JPEG, WebP, GIF, MP4 or WebM materials.')}</small>}
                  {materialFiles.length > 8 && <small role="status">{t('Connect up to eight materials.')}</small>}
                  <MaterialPrompt item={item} version={materialVersion} files={materialFiles} busy={busy} update={fields => updateSolutionPrompt(item, fields)} />
                </>}
                {!mixed && mediaInputs.length > imageInputs.length && <small role="status">{t('Connect a solution to use a video in its showcase.')}</small>}
                {missing && <small role="status">{t('A connected solution version is unavailable.')}</small>}
                {!mixed && inputFiles.length > 0 && <small className="canvas-prompt-inputs" aria-label={t('Input images')}>{inputFiles.map((id, index) => <span key={id}>{t('Image')} {index + 1}: {currentFiles.find(file => file.id === id)?.title ?? id}</span>)}</small>}
                {hasSolution && !mixed && <SolutionPrompt item={item} sources={sources} busy={busy} update={fields => updateSolutionPrompt(item, fields)} moveInput={index => moveSolutionInput(item, index)} />}
              </PromptDialogue>
              <footer className="composer-wrap">
                <div className="prompt-dialog-status">
                  <span role="status" data-task-status={task?.status ?? (busy ? 'submitted' : 'Ready')}>{busy && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{t(statusLabel)}</span>
                  {task && !busy && ['failed', 'cancelled', 'interrupted'].includes(task.status) && <button onClick={() => action('retry')}>{t('Retry')}</button>}
                </div>
                {!mixed && commandError && <small role="alert">{t(commandError)}</small>}
                {task?.error && <small role="alert">{t(task.error)}</small>}
                {mixed ? <button type="button" className="material-submit" disabled={busy ? !task : !canSend} onClick={busy ? () => action('cancel') : send}>{t(busy ? 'Cancel' : 'Generate new version')}</button> :
                <PromptComposer value={item.text ?? ''} busy={busy} canSend={canSend} canStop={Boolean(task && (imageRunning(imageTask?.status) || solutionRunning(solutionTask?.status)))} label={hasSolution ? 'Run solution edit' : 'Generate edit'} update={text => updateSolutionPrompt(item, { text })} send={send} stop={() => action('cancel')} begin={() => history.begin()} end={() => history.end()} />}
              </footer>
              <button className="canvas-resize-handle" aria-label={t('Resize prompt')} onPointerDown={event => beginElement(event, item, true)} />
            </article>;
          })()
          : item.kind === 'html' ? <article key={item.id} data-element-id={item.id} className={`canvas-note canvas-html-page ${selectedIds.includes(item.id) ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}><strong>{item.text}</strong><p>{t('HTML interface')}</p><button onPointerDown={event => event.stopPropagation()} onClick={() => item.assetPath && onOpenPreview?.(item.assetPath)}>{t('Open prototype')} <ExternalLink size={13} /></button></article>
          : item.kind === 'text' ? <article key={item.id} data-element-id={item.id} className={`canvas-note ${selectedIds.includes(item.id) ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}>{item.text}</article> : null)}
      </div> : null}
      {selectionBox && <div className="canvas-selection-box" aria-hidden="true" style={{ left: camera.x + selectionBox.x * camera.zoom, top: camera.y + selectionBox.y * camera.zoom, width: selectionBox.width * camera.zoom, height: selectionBox.height * camera.zoom }} />}
      {dropActive && <div className="canvas-drop-indicator">{t('Drop to add to the editor')}</div>}
    </div>
    <div className="canvas-toolbar" aria-label={t('Canvas controls')}>
      <div className="canvas-tool-group" role="group" aria-label={t('Selection tools')}>
        <button className={tool === 'select' ? 'active' : ''} aria-pressed={tool === 'select'} title={t('Selection: Shift-click to add or remove; drag empty space to select')} aria-label={t('Select and move elements')} onClick={() => setTool('select')}><MousePointer2 size={16} /></button>
        <button className={tool === 'hand' ? 'active' : ''} aria-pressed={tool === 'hand'} title={t('Pan canvas')} aria-label={t('Pan canvas')} onClick={() => setTool('hand')}><Hand size={16} /></button>
      </div>
      <div className="canvas-tool-group" role="group" aria-label={t('Card actions')}>
        <button disabled={!ready} aria-label={t('Create prompt card')} title={t('Create prompt card')} onClick={createPrompt}><MessageSquarePlus size={16} /></button>
        <button disabled={(!selectedIds.length && !selectedEdge) || !ready} aria-label={t('Remove selected element')} title={t('Remove selected element')} onClick={removeSelected}><Trash2 size={16} /></button>
      </div>
      <div className="canvas-tool-group" role="group" aria-label={t('Edit history')}>
        <button disabled={!history.canUndo || !ready} aria-label={t('Undo')} onClick={() => { history.undo(); setDirty(true); }}><Undo2 size={16} /></button>
        <button disabled={!history.canRedo || !ready} aria-label={t('Redo')} onClick={() => { history.redo(); setDirty(true); }}><Redo2 size={16} /></button>
      </div>
      <div className="canvas-tool-group" role="group" aria-label={t('Canvas view')}>
        <button disabled={!ready} aria-label={t('Zoom out')} onClick={() => zoomAt(camera.zoom - .1)}><Minus size={15} /></button>
        <button disabled={!ready} className="zoom-label" aria-label={t('Reset to 100%')} title={t('Reset to 100%')} onClick={() => zoomAt(1)}>{Math.round(camera.zoom * 100)}%</button>
        <button disabled={!ready} aria-label={t('Zoom in')} onClick={() => zoomAt(camera.zoom + .1)}><Plus size={15} /></button>
        <button disabled={!ready} aria-label={t('Fit project')} onClick={fit}><Scan size={16} /></button>
      </div>
      <div className="canvas-tool-group" role="group" aria-label={t('Layout and guides')}>
        <button disabled={!ready} aria-label={t('Reflow project cards')} title={t('Reflow project cards')} onClick={reflow}><LayoutGrid size={16} /></button>
        <button className={guides.dots ? 'active' : ''} aria-label={t('Positioning dots')} aria-pressed={guides.dots} title={t(guides.dots ? 'Hide positioning dots' : 'Show positioning dots')} onClick={() => setGuides(current => ({ ...current, dots: !current.dots }))}><Grip size={16} /></button>
        <button className={guides.grid ? 'active' : ''} aria-label={t('Grid lines')} aria-pressed={guides.grid} title={t(guides.grid ? 'Hide grid lines' : 'Show grid lines')} onClick={() => setGuides(current => ({ ...current, grid: !current.grid }))}><Grid3X3 size={16} /></button>
      </div>
      {persistence.saving && <span className="canvas-saving">{t('Saving…')}</span>}
    </div>
    {(notice || persistence.error) && <div className="canvas-notice" role="alert">{t(persistence.error ?? notice!)}{persistence.error && <button onClick={persistence.retry}>{t('Retry')}</button>}</div>}
  </main>;
}
