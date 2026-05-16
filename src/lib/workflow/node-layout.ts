import type { CanvasNodeType, WorkflowEdge, WorkflowNode } from "@/lib/workflow/schema";

/**
 * Approximate node size for centering new blocks on the cursor (flow coords use top-left).
 */
export const NODE_ANCHOR: Record<CanvasNodeType, { w: number; h: number }> = {
  mediaInput: { w: 280, h: 312 },
  generationBlock: { w: 340, h: 340 },
  platformExport: { w: 260, h: 320 },
};

/** Horizontal gap between columns (after widest node in the column). */
const LAYOUT_COLUMN_GAP = 100;
/** Vertical gap between stacked nodes in the same column. */
const LAYOUT_ROW_GAP = 72;

function anchorForNode(node: WorkflowNode): { w: number; h: number } {
  const t = node.type;
  if (t === "mediaInput" || t === "generationBlock" || t === "platformExport") {
    return NODE_ANCHOR[t];
  }
  return NODE_ANCHOR.generationBlock;
}

/**
 * Layer nodes by DAG depth (longest path from a source), then place each layer in a column
 * with nodes stacked vertically and centered using {@link NODE_ANCHOR} sizes.
 */
export function layoutWorkflowNodesCompactDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const n of nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    incoming.get(e.target)!.push(e.source);
    outgoing.get(e.source)!.push(e.target);
  }

  const inDegree = new Map<string, number>();
  for (const id of ids) {
    inDegree.set(id, incoming.get(id)!.length);
  }
  const queue = [...ids].filter((id) => inDegree.get(id) === 0).sort((a, b) => a.localeCompare(b));
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    const outs = [...(outgoing.get(id) ?? [])].sort((a, b) => a.localeCompare(b));
    for (const next of outs) {
      const d = inDegree.get(next)! - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
    queue.sort((a, b) => a.localeCompare(b));
  }

  if (topo.length !== ids.size) {
    return nodes.map((n, i) => ({
      ...n,
      position: {
        x: i * (NODE_ANCHOR.generationBlock.w + LAYOUT_COLUMN_GAP),
        y: 0,
      },
    }));
  }

  const depth = new Map<string, number>();
  for (const id of topo) {
    const preds = incoming.get(id) ?? [];
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

  const maxDepth = Math.max(0, ...depth.values());
  const byDepth = new Map<number, WorkflowNode[]>();
  for (let d = 0; d <= maxDepth; d += 1) {
    byDepth.set(d, []);
  }
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    byDepth.get(d)!.push(n);
  }
  for (let d = 0; d <= maxDepth; d += 1) {
    byDepth.get(d)!.sort((a, b) => a.id.localeCompare(b.id));
  }

  const colWidths: number[] = [];
  for (let d = 0; d <= maxDepth; d += 1) {
    const layer = byDepth.get(d)!;
    const mw = layer.reduce((m, n) => Math.max(m, anchorForNode(n).w), 56);
    colWidths.push(mw);
  }

  const colLeftX: number[] = [];
  let xCursor = 0;
  for (let d = 0; d <= maxDepth; d += 1) {
    colLeftX.push(xCursor);
    xCursor += colWidths[d]! + LAYOUT_COLUMN_GAP;
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (let d = 0; d <= maxDepth; d += 1) {
    const layer = byDepth.get(d)!;
    const heights = layer.map((n) => anchorForNode(n).h);
    const totalH =
      heights.reduce((a, h) => a + h, 0) + Math.max(0, layer.length - 1) * LAYOUT_ROW_GAP;
    let yTop = -totalH / 2;
    const colW = colWidths[d]!;
    const left = colLeftX[d]!;
    for (let i = 0; i < layer.length; i += 1) {
      const n = layer[i]!;
      const { w, h } = anchorForNode(n);
      const xPos = left + (colW - w) / 2;
      pos.set(n.id, { x: xPos, y: yTop });
      yTop += h + LAYOUT_ROW_GAP;
    }
  }

  return nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return n;
    return { ...n, position: p };
  });
}

export function topLeftForCenteredNode(
  center: { x: number; y: number },
  type: CanvasNodeType,
) {
  const { w, h } = NODE_ANCHOR[type];
  return { x: center.x - w / 2, y: center.y - h / 2 };
}
