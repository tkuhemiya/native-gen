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
