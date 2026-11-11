export const PROMPT_MIN_SIZE = { width: 300, height: 240 } as const;
/** Pure canvas data rules, shared by persistence and interactions. Ports hold any number of edges. */
export interface CanvasEdge { id: string; source: string; target: string }
export interface GraphNode { id: string; kind: string }
export function canvasConnectionIssue(nodes: GraphNode[], edges: CanvasEdge[], source: string, target: string) {
  const kind = (id: string) => {
    const value = nodes.find(node => node.id === id)?.kind;
    return value === 'solution-prompt' ? 'prompt' : value;
  };
  const from = kind(source), to = kind(target);
  const isInput = (value: string | undefined) => value === 'image' || value === 'solution';
  if (source === target) return 'cycle';
  if (!(((isInput(from) || from === 'video') && to === 'prompt') || (from === 'prompt' && isInput(to)))) return 'incompatible';
  if (edges.some(edge => edge.source === source && edge.target === target)) return 'duplicate';
  // A creation chain is a DAG; cycles cannot express a material's provenance.
  const pending = [target], visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return 'cycle';
    if (visited.has(id)) continue;
    visited.add(id); edges.filter(edge => edge.source === id).forEach(edge => pending.push(edge.target));
  }
  return undefined;
}

export function validCanvasConnection(nodes: GraphNode[], edges: CanvasEdge[], source: string, target: string): boolean {
  return canvasConnectionIssue(nodes, edges, source, target) === undefined;
}
export function normalizeCanvasEdges(nodes: GraphNode[], value: unknown): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  if (Array.isArray(value)) for (const entry of value) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 180 || typeof entry.source !== 'string' || typeof entry.target !== 'string' || edges.some(edge => edge.id === entry.id)) continue;
    if (validCanvasConnection(nodes, edges, entry.source, entry.target)) edges.push({ id: entry.id, source: entry.source, target: entry.target });
  }
  return edges;
}
