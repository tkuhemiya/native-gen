import type { WorkflowEdge, WorkflowNode } from "./schema";

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

function buildAdjacency(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const n of nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }

  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      throw new GraphError(`Edge ${e.id} references unknown node`);
    }
    incoming.get(e.target)!.push(e.source);
    outgoing.get(e.source)!.push(e.target);
  }

  return { incoming, outgoing, ids };
}

/** Returns true if a directed cycle exists (DFS). */
export function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  const { outgoing, ids } = buildAdjacency(nodes, edges);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const id of ids) {
    if (dfs(id)) return true;
  }
  return false;
}

/** Kahn topological sort; throws if cycle. */
export function topologicalOrder(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): string[] {
  if (hasCycle(nodes, edges)) {
    throw new GraphError("Workflow has a cycle — only DAGs are supported");
  }

  const { incoming, outgoing, ids } = buildAdjacency(nodes, edges);
  const inDegree = new Map<string, number>();
  for (const id of ids) {
    inDegree.set(id, incoming.get(id)!.length);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const ordered: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const nextDeg = inDegree.get(next)! - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }

  if (ordered.length !== ids.size) {
    throw new GraphError("Unable to order workflow (unexpected cycle or mismatch)");
  }

  return ordered;
}

/** Stable left-to-right tie-break for equally-ready nodes (canvas layout). */
export function sortNodeIdsPreferLeft(
  ids: string[],
  nodesById: Map<string, WorkflowNode>,
): void {
  ids.sort((a, b) => {
    const na = nodesById.get(a)!;
    const nb = nodesById.get(b)!;
    if (na.position.x !== nb.position.x) return na.position.x - nb.position.x;
    if (na.position.y !== nb.position.y) return na.position.y - nb.position.y;
    return a.localeCompare(b);
  });
}

/** In-degree and outgoing adjacency for DAG scheduling. */
export function buildWorkflowInDegrees(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { inDegree: Map<string, number>; outgoing: Map<string, string[]> } {
  if (hasCycle(nodes, edges)) {
    throw new GraphError("Workflow has a cycle — only DAGs are supported");
  }
  const { incoming, outgoing, ids } = buildAdjacency(nodes, edges);
  const inDegree = new Map<string, number>();
  for (const id of ids) {
    inDegree.set(id, incoming.get(id)!.length);
  }
  return { inDegree, outgoing };
}

/**
 * Same as topological order for a DAG, but when several nodes are runnable,
 * prefers smaller `position.x` (then `y`, then id) so execution aligns with a
 * typical left-to-right canvas layout without breaking dependencies.
 */
export function topologicalOrderPreferLeft(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { inDegree, outgoing } = buildWorkflowInDegrees(nodes, edges);

  const ready: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) ready.push(id);
  }
  sortNodeIdsPreferLeft(ready, byId);

  const ordered: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const nextDeg = inDegree.get(next)! - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) {
        ready.push(next);
        sortNodeIdsPreferLeft(ready, byId);
      }
    }
  }

  if (ordered.length !== inDegree.size) {
    throw new GraphError("Unable to order workflow (unexpected cycle or mismatch)");
  }

  return ordered;
}

/**
 * Topological layers: nodes in each wave can run concurrently (all predecessors
 * are in earlier waves). Tie-breaking matches {@link topologicalOrderPreferLeft}.
 */
export function topologicalWavesPreferLeft(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): string[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { inDegree, outgoing } = buildWorkflowInDegrees(nodes, edges);
  const remaining = new Map(inDegree);
  const waves: string[][] = [];

  let ready: string[] = [];
  for (const [id, deg] of remaining) {
    if (deg === 0) ready.push(id);
  }
  sortNodeIdsPreferLeft(ready, byId);

  while (ready.length > 0) {
    waves.push([...ready]);
    const nextReady: string[] = [];
    for (const id of ready) {
      for (const next of outgoing.get(id) ?? []) {
        const nextDeg = remaining.get(next)! - 1;
        remaining.set(next, nextDeg);
        if (nextDeg === 0) nextReady.push(next);
      }
    }
    sortNodeIdsPreferLeft(nextReady, byId);
    ready = nextReady;
  }

  if (waves.flat().length !== inDegree.size) {
    throw new GraphError("Unable to order workflow (unexpected cycle or mismatch)");
  }

  return waves;
}

/** Incoming edges keyed by target node id (order preserved: first occurrence appends). */
export function buildIncomingByTarget(edges: WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const m = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    const list = m.get(e.target) ?? [];
    list.push(e);
    m.set(e.target, list);
  }
  return m;
}

/**
 * Clip → join edges in stable order: order of appearance in `edges` (migration + user wiring order).
 */
export function sortedIncomingClipEdgesForJoin(
  joinId: string,
  edges: WorkflowEdge[],
): WorkflowEdge[] {
  const hits = edges
    .map((e, idx) => ({ e, idx }))
    .filter(
      ({ e }) =>
        e.target === joinId && (e.targetHandle === "clips" || e.targetHandle == null),
    );
  hits.sort((a, b) => a.idx - b.idx);
  return hits.map((h) => h.e);
}

export function assertSceneJoinClipWiring(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (node.data.kind !== "sceneJoin") continue;
    const clipEdges = sortedIncomingClipEdgesForJoin(node.id, edges);
    if (clipEdges.length === 0) {
      throw new GraphError(
        `Join “${node.data.label.trim() || node.data.kind}” needs at least one video clip wired to the clips pin`,
      );
    }
    for (const e of clipEdges) {
      const src = nodesById.get(e.source);
      if (!src || src.data.kind !== "videoBlock") {
        throw new GraphError(
          `Join “${node.data.label.trim() || node.data.kind}” only accepts clips from video blocks`,
        );
      }
      if (e.sourceHandle != null && e.sourceHandle !== "video") {
        throw new GraphError(
          `Join “${node.data.label.trim() || node.data.kind}”: wire from each clip’s **video** output pin`,
        );
      }
    }
  }
}

export function assertConnectedDAG(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  if (nodes.length === 0) return;
  if (edges.length === 0 && nodes.length > 1) {
    throw new GraphError("Disconnected workflow: connect nodes before running");
  }

  const { ids } = buildAdjacency(nodes, edges);
  const undirected = new Map<string, Set<string>>();
  for (const id of ids) undirected.set(id, new Set());
  for (const e of edges) {
    undirected.get(e.source)!.add(e.target);
    undirected.get(e.target)!.add(e.source);
  }

  const start = nodes[0].id;
  const stack = [start];
  const seen = new Set<string>([start]);
  while (stack.length) {
    const id = stack.pop()!;
    for (const n of undirected.get(id) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }

  if (seen.size !== ids.size) {
    throw new GraphError("Disconnected islands detected — connect all nodes");
  }
}
