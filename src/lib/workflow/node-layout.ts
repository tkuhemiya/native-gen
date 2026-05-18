import type { CanvasNodeType, WorkflowEdge, WorkflowNode } from "@/lib/workflow/schema";

/**
 * Approximate node size for centering new blocks on the cursor (flow coords use top-left).
 */
export const NODE_ANCHOR: Record<CanvasNodeType, { w: number; h: number }> = {
  textPrimitive: { w: 280, h: 260 },
  imagePrimitive: { w: 280, h: 280 },
  sceneCompose: { w: 300, h: 220 },
  sceneJoin: { w: 320, h: 320 },
  generationBlock: { w: 340, h: 340 },
  videoBlock: { w: 320, h: 360 },
  outputBlock: { w: 320, h: 380 },
};

/** Minimum horizontal gap along an edge (one-to-one wiring). */
const BASE_EDGE_GAP_X = 96;
/** Extra horizontal span per additional **incoming** edge (beyond the first) to a node — hubs sit further right ("global"). */
const FAN_IN_EXTRA_X = 52;
/** Extra horizontal span per additional **outgoing** edge (beyond the first) from a source — busy fan-out pulls children away. */
const FAN_OUT_EXTRA_X = 40;
/** Vertical gap between stacked nodes in the same layer. */
const LAYOUT_ROW_GAP = 168;

function anchorForNode(node: WorkflowNode): { w: number; h: number } {
  const t = node.type;
  if (
    t === "textPrimitive" ||
    t === "imagePrimitive" ||
    t === "sceneCompose" ||
    t === "sceneJoin" ||
    t === "generationBlock" ||
    t === "videoBlock" ||
    t === "outputBlock"
  ) {
    return NODE_ANCHOR[t];
  }
  return NODE_ANCHOR.generationBlock;
}

function uniqStrings(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

function edgeGapFromPredToTarget(
  predId: string,
  targetId: string,
  uniqInCount: (id: string) => number,
  uniqOutCount: (id: string) => number,
): number {
  return (
    BASE_EDGE_GAP_X +
    FAN_IN_EXTRA_X * Math.max(0, uniqInCount(targetId) - 1) +
    FAN_OUT_EXTRA_X * Math.max(0, uniqOutCount(predId) - 1)
  );
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Longest-path depth from sources (0 = roots), in topological order. */
function computeDepthLongestPath(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  topo: string[],
): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    incoming.get(e.target)!.push(e.source);
  }

  const depth = new Map<string, number>();
  for (const id of topo) {
    const preds = uniqStrings(incoming.get(id));
    if (preds.length === 0) {
      depth.set(id, 0);
    } else {
      let d = 0;
      for (const p of preds) {
        d = Math.max(d, (depth.get(p) ?? 0) + 1);
      }
      depth.set(id, d);
    }
  }
  return depth;
}

function tryTopologicalOrder(
  ids: Set<string>,
  incomingEdges: Map<string, string[]>,
  outgoingEdges: Map<string, string[]>,
): string[] | null {
  const inDegree = new Map<string, number>();
  for (const id of ids) {
    inDegree.set(id, (incomingEdges.get(id) ?? []).length);
  }
  const queue = [...ids].filter((id) => inDegree.get(id) === 0).sort((a, b) => a.localeCompare(b));
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    const outs = [...(outgoingEdges.get(id) ?? [])].sort((a, b) => a.localeCompare(b));
    for (const next of outs) {
      const d = inDegree.get(next)! - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
    queue.sort((a, b) => a.localeCompare(b));
  }
  return topo.length === ids.size ? topo : null;
}

/**
 * Join and output handles use vertical center (`top-1/2`). When an output's only upstream is a scene
 * join, snap its top-left `y` so anchor centers line up (straight horizontal edge). Multiple outputs fed
 * only by the same join are stacked and centered on the join's vertical axis.
 */
function alignOutputsToUpstreamSceneJoins(
  nodes: WorkflowNode[],
  incomingEdges: Map<string, string[]>,
  yPos: Map<string, number>,
): void {
  const nById = new Map(nodes.map((n) => [n.id, n]));
  const byJoin = new Map<string, WorkflowNode[]>();

  for (const n of nodes) {
    if (n.data.kind !== "outputBlock") continue;
    const preds = uniqStrings(incomingEdges.get(n.id));
    if (preds.length !== 1) continue;
    const pid = preds[0]!;
    const p = nById.get(pid);
    if (!p || p.data.kind !== "sceneJoin") continue;
    const list = byJoin.get(pid) ?? [];
    list.push(n);
    byJoin.set(pid, list);
  }

  for (const outs of byJoin.values()) {
    outs.sort((a, b) => a.id.localeCompare(b.id));
  }

  for (const [joinId, outs] of byJoin) {
    const jNode = nById.get(joinId);
    if (outs.length === 0 || !jNode) continue;
    const yJ = yPos.get(joinId);
    if (yJ === undefined) continue;
    const hj = anchorForNode(jNode).h;
    const joinCenterY = yJ + hj / 2;

    const heights = outs.map((o) => anchorForNode(o).h);
    const betweenOutputs = Math.min(LAYOUT_ROW_GAP, 96);
    const totalH =
      heights.reduce((a, h) => a + h, 0) + Math.max(0, outs.length - 1) * betweenOutputs;
    let yTop = joinCenterY - totalH / 2;

    for (let i = 0; i < outs.length; i += 1) {
      const o = outs[i]!;
      yPos.set(o.id, yTop);
      yTop += heights[i]! + (i < outs.length - 1 ? betweenOutputs : 0);
    }
  }
}

/**
 * DAG layout driven by connectivity:
 * - horizontal gap from a predecessor to its child grows when the **child** has many inputs (fan-in) or the **predecessor** has many outputs (fan-out), so tight one-to-one chains stay compact and hub-like nodes read as “global”.
 * - vertical order within a layer follows median predecessor Y so dependents sit near their parents.
 *
 * Cycles fall back to a simple horizontal strip.
 */
function layoutWorkflowNodesConnectionAware(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const nById = new Map(nodes.map((n) => [n.id, n]));
  const incomingEdges = new Map<string, string[]>();
  const outgoingEdges = new Map<string, string[]>();
  for (const n of nodes) {
    incomingEdges.set(n.id, []);
    outgoingEdges.set(n.id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    incomingEdges.get(e.target)!.push(e.source);
    outgoingEdges.get(e.source)!.push(e.target);
  }

  const uniqInCount = (id: string) => uniqStrings(incomingEdges.get(id)).length;
  const uniqOutCount = (id: string) => uniqStrings(outgoingEdges.get(id)).length;

  const topo = tryTopologicalOrder(ids, incomingEdges, outgoingEdges);
  if (!topo) {
    return nodes.map((n, i) => ({
      ...n,
      position: {
        x: i * (NODE_ANCHOR.generationBlock.w + BASE_EDGE_GAP_X),
        y: 0,
      },
    }));
  }

  const depthMap = computeDepthLongestPath(nodes, edges, topo);

  const maxDepth = Math.max(0, ...depthMap.values());
  const byDepth = new Map<number, WorkflowNode[]>();
  for (let d = 0; d <= maxDepth; d += 1) {
    byDepth.set(d, []);
  }
  for (const n of nodes) {
    const d = depthMap.get(n.id) ?? 0;
    byDepth.get(d)!.push(n);
  }
  for (let d = 0; d <= maxDepth; d += 1) {
    byDepth.get(d)!.sort((a, b) => a.id.localeCompare(b.id));
  }

  const xRaw = new Map<string, number>();

  for (let d = 0; d <= maxDepth; d += 1) {
    const layer = byDepth.get(d)!;
    for (const n of layer) {
      if (d === 0) {
        xRaw.set(n.id, 0);
        continue;
      }
      const preds = uniqStrings(incomingEdges.get(n.id));
      if (preds.length === 0) {
        xRaw.set(n.id, 0);
        continue;
      }
      let maxRight = 0;
      for (const p of preds) {
        const px = xRaw.get(p);
        if (px === undefined) continue;
        const predNode = nById.get(p);
        if (!predNode) continue;
        const { w } = anchorForNode(predNode);
        const gap = edgeGapFromPredToTarget(p, n.id, uniqInCount, uniqOutCount);
        maxRight = Math.max(maxRight, px + w + gap);
      }
      xRaw.set(n.id, maxRight);
    }
  }

  const xsPlaced = [...xRaw.values()];
  const minX = xsPlaced.length ? Math.min(...xsPlaced) : 0;
  const xPos = new Map<string, number>();
  for (const n of nodes) {
    xPos.set(n.id, (xRaw.get(n.id) ?? 0) - minX);
  }

  const yPos = new Map<string, number>();

  for (let d = 0; d <= maxDepth; d += 1) {
    let layer = [...(byDepth.get(d) ?? [])];

    if (d === 0) {
      layer.sort((a, b) => a.id.localeCompare(b.id));
    } else {
      layer.sort((a, b) => {
        const predsA = uniqStrings(incomingEdges.get(a.id));
        const predsB = uniqStrings(incomingEdges.get(b.id));
        const yA = median(predsA.map((p) => yPos.get(p) ?? 0));
        const yB = median(predsB.map((p) => yPos.get(p) ?? 0));
        if (yA !== yB) return yA - yB;
        return a.id.localeCompare(b.id);
      });
    }

    const heights = layer.map((n) => anchorForNode(n).h);
    const totalH =
      heights.reduce((a, h) => a + h, 0) + Math.max(0, layer.length - 1) * LAYOUT_ROW_GAP;
    let yTop = -totalH / 2;

    for (let i = 0; i < layer.length; i += 1) {
      const n = layer[i]!;
      yPos.set(n.id, yTop);
      yTop += anchorForNode(n).h + LAYOUT_ROW_GAP;
    }
  }

  alignOutputsToUpstreamSceneJoins(nodes, incomingEdges, yPos);

  return nodes.map((n) => {
    const x = xPos.get(n.id) ?? 0;
    const y = yPos.get(n.id) ?? 0;
    return { ...n, position: { x, y } };
  });
}

/**
 * Layout the workflow graph using connectivity-based spacing (fan-in / fan-out) and predecessor-aware vertical ordering.
 */
export function layoutWorkflowNodesCompactDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowNode[] {
  if (nodes.length === 0) return nodes;
  return layoutWorkflowNodesConnectionAware(nodes, edges);
}

export function topLeftForCenteredNode(
  center: { x: number; y: number },
  type: CanvasNodeType,
) {
  const { w, h } = NODE_ANCHOR[type];
  return { x: center.x - w / 2, y: center.y - h / 2 };
}
