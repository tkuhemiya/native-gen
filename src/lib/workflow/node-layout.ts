import type { CanvasNodeType, WorkflowEdge, WorkflowNode } from "@/lib/workflow/schema";
import {
  inferSceneSortIndex,
  inferTextPrimitiveStoryRole,
  storyRoleSortKey,
} from "@/lib/workflow/story-node-role";

type TextStoryWorkflowNode = WorkflowNode & {
  data: Extract<WorkflowNode["data"], { kind: "textPrimitive" }>;
};

type ImageStoryWorkflowNode = WorkflowNode & {
  data: Extract<WorkflowNode["data"], { kind: "imagePrimitive" }>;
};

function isStoryImageNode(n: WorkflowNode): n is ImageStoryWorkflowNode {
  return n.data.kind === "imagePrimitive";
}

function isStoryTextNode(n: WorkflowNode): n is TextStoryWorkflowNode {
  return n.data.kind === "textPrimitive";
}

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

/** Horizontal gap between DAG depth columns (after the widest node in each column). */
const LAYOUT_COLUMN_GAP = 220;
/** Vertical gap between stacked nodes in the same column (tidy / agent layout). */
const LAYOUT_ROW_GAP = 120;

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

function topoOrderOrNull(
  ids: Set<string>,
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
): string[] | null {
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
  return topo.length === ids.size ? topo : null;
}

function isTextToGenTextPin(e: WorkflowEdge, nById: Map<string, WorkflowNode>): boolean {
  const src = nById.get(e.source);
  const tgt = nById.get(e.target);
  if (!src || !tgt) return false;
  if (tgt.data.kind !== "generationBlock") return false;
  if (src.data.kind !== "textPrimitive") return false;
  const th = e.targetHandle;
  return th === "text" || th === null || th === undefined;
}

function isImageToGenRefPin(e: WorkflowEdge, nById: Map<string, WorkflowNode>): boolean {
  const src = nById.get(e.source);
  const tgt = nById.get(e.target);
  if (!src || !tgt) return false;
  if (tgt.data.kind !== "generationBlock") return false;
  if (src.data.kind !== "imagePrimitive") return false;
  const th = e.targetHandle;
  return th === "image" || th === null || th === undefined;
}

function isGenToVideoImagePin(e: WorkflowEdge, nById: Map<string, WorkflowNode>): boolean {
  const src = nById.get(e.source);
  const tgt = nById.get(e.target);
  if (!src || !tgt) return false;
  if (src.data.kind !== "generationBlock" || tgt.data.kind !== "videoBlock") return false;
  const th = e.targetHandle;
  return th === "image" || th === null || th === undefined;
}

function directTextFeedsToGen(
  genId: string,
  edges: WorkflowEdge[],
  nById: Map<string, WorkflowNode>,
): TextStoryWorkflowNode[] {
  const out: TextStoryWorkflowNode[] = [];
  for (const e of edges) {
    if (e.target !== genId) continue;
    if (!isTextToGenTextPin(e, nById)) continue;
    const n = nById.get(e.source);
    if (n && isStoryTextNode(n)) out.push(n);
  }
  return out;
}

function pairCharacterPortraitImages(
  textNodes: TextStoryWorkflowNode[],
  imageNodes: ImageStoryWorkflowNode[],
  genNodes: WorkflowNode[],
  edges: WorkflowEdge[],
  nById: Map<string, WorkflowNode>,
): Map<string, string> {
  const pair = new Map<string, string>();
  const usedImages = new Set<string>();

  const charTexts = textNodes.filter(
    (n) => inferTextPrimitiveStoryRole(n.data.label, n.data.purpose) === "character",
  );

  for (const ct of charTexts) {
    const gensFromChar = new Set(
      edges
        .filter((e) => e.source === ct.id && nById.get(e.target)?.data.kind === "generationBlock")
        .map((e) => e.target),
    );
    if (gensFromChar.size === 0) continue;

    const candidateImgs = imageNodes.filter((img) => {
      if (usedImages.has(img.id)) return false;
      const gensFromImg = new Set(
        edges.filter((e) => e.source === img.id && isImageToGenRefPin(e, nById)).map((e) => e.target),
      );
      if (gensFromImg.size === 0) return false;
      for (const g of gensFromChar) {
        if (gensFromImg.has(g)) return true;
      }
      return false;
    });

    const ranked = [...candidateImgs].sort((a, b) => {
      const la = `${a.data.label} ${a.data.prompt}`.toLowerCase();
      const lb = `${b.data.label} ${b.data.prompt}`.toLowerCase();
      const sa = /portrait|face|headshot|mug|still/.test(la) ? 0 : 1;
      const sb = /portrait|face|headshot|mug|still/.test(lb) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (/character|protagonist/.test(la) && !/character|protagonist/.test(lb)) return -1;
      if (!/character|protagonist/.test(la) && /character|protagonist/.test(lb)) return 1;
      return a.id.localeCompare(b.id);
    });

    const pick =
      ranked[0] ??
      candidateImgs.find((img) => /portrait|character|ref|still/.test(`${img.data.label} ${img.data.prompt}`.toLowerCase()));

    if (pick && !pair.has(ct.id)) {
      pair.set(ct.id, pick.id);
      usedImages.add(pick.id);
    }
  }

  if (pair.size === 0) {
    for (const g of genNodes) {
      const imgs = edges
        .filter((e) => e.target === g.id && isImageToGenRefPin(e, nById))
        .map((e) => nById.get(e.source)!)
        .filter(Boolean);
      const texts = directTextFeedsToGen(g.id, edges, nById);
      const charT = texts.filter(
        (t) => inferTextPrimitiveStoryRole(t.data.label, t.data.purpose) === "character",
      );
      if (imgs.length === 1 && charT.length === 1 && !usedImages.has(imgs[0]!.id) && !pair.has(charT[0]!.id)) {
        pair.set(charT[0]!.id, imgs[0]!.id);
        usedImages.add(imgs[0]!.id);
        break;
      }
    }
  }

  return pair;
}

/**
 * Storyboard-style lanes: globals + character portrait beside sheet, scene beats in rows,
 * gens/videos aligned per scene, join/output on the right. Falls back when the graph
 * has unmigrated oddities.
 */
function tryLayoutWorkflowStoryAware(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] | null {
  const nById = new Map(nodes.map((n) => [n.id, n]));
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

  const topo = topoOrderOrNull(ids, incoming, outgoing);
  if (!topo) return null;

  const genNodes = nodes.filter((n) => n.data.kind === "generationBlock");
  if (genNodes.length === 0) return null;

  const videoNodes = nodes.filter((n) => n.data.kind === "videoBlock");
  const joinNodes = nodes.filter((n) => n.data.kind === "sceneJoin");
  const outputNodes = nodes.filter((n) => n.data.kind === "outputBlock");
  const textNodes = nodes.filter(isStoryTextNode);
  const imageNodes = nodes.filter(isStoryImageNode);
  const composeNodes = nodes.filter((n) => n.data.kind === "sceneCompose");

  const X_GLOBAL = 0;
  const X_SCENE = 520;
  const X_COMPOSE = 820;
  const X_GEN = 1040;
  const X_VIDEO = 1420;
  const X_JOIN = 1840;
  const X_OUT = 2220;
  const LANE_GAP_Y = 130;
  const STACK_GAP_Y = 24;
  const GLOBAL_RIGHT_PAD = 48;

  const pos = new Map<string, { x: number; y: number }>();
  const placed = new Set<string>();

  const portraitPair = pairCharacterPortraitImages(textNodes, imageNodes, genNodes, edges, nById);

  const globalTexts = textNodes
    .filter((n) => inferTextPrimitiveStoryRole(n.data.label, n.data.purpose) !== "scene")
    .sort((a, b) => {
      const ra = inferTextPrimitiveStoryRole(a.data.label, a.data.purpose);
      const rb = inferTextPrimitiveStoryRole(b.data.label, b.data.purpose);
      const oa = storyRoleSortKey(ra);
      const ob = storyRoleSortKey(rb);
      if (oa !== ob) return oa - ob;
      return a.id.localeCompare(b.id);
    });

  let yGlobal = 0;
  for (const t of globalTexts) {
    const role = inferTextPrimitiveStoryRole(t.data.label, t.data.purpose);
    const tw = anchorForNode(t).w;
    const th = anchorForNode(t).h;
    pos.set(t.id, { x: X_GLOBAL, y: yGlobal });
    placed.add(t.id);

    const pairImgId = portraitPair.get(t.id);
    let rowH = th;
    if (pairImgId && role === "character") {
      const imgNode = nById.get(pairImgId);
      if (imgNode) {
        const ih = anchorForNode(imgNode).h;
        pos.set(pairImgId, { x: X_GLOBAL + tw + GLOBAL_RIGHT_PAD, y: yGlobal });
        placed.add(pairImgId);
        rowH = Math.max(th, ih);
      }
    }
    yGlobal += rowH + STACK_GAP_Y;
  }

  const sceneTexts = textNodes
    .filter((n) => inferTextPrimitiveStoryRole(n.data.label, n.data.purpose) === "scene")
    .sort((a, b) => {
      const ia = inferSceneSortIndex(a.data.label, a.data.purpose);
      const ib = inferSceneSortIndex(b.data.label, b.data.purpose);
      if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ia - ib;
      return a.id.localeCompare(b.id);
    });

  const ySceneBase = yGlobal + 56;
  const heightsForStride = [
    ...genNodes.map((n) => anchorForNode(n).h),
    ...videoNodes.map((n) => anchorForNode(n).h),
    ...sceneTexts.map((n) => anchorForNode(n).h),
  ];
  const rowStride = Math.max(
    heightsForStride.length > 0 ? Math.max(...heightsForStride) : 0,
    LANE_GAP_Y + 40,
  );

  const sceneById = new Map(sceneTexts.map((n, i) => [n.id, i]));
  const genByRow = new Map<string, number>();

  const gensOrdered = [...genNodes].sort((a, b) => a.id.localeCompare(b.id));
  for (let gi = 0; gi < gensOrdered.length; gi += 1) {
    const g = gensOrdered[gi]!;
    const textsIn = directTextFeedsToGen(g.id, edges, nById);
    const scenePreds = textsIn.filter(
      (t) => inferTextPrimitiveStoryRole(t.data.label, t.data.purpose) === "scene",
    );
    let row = gi;
    if (scenePreds.length === 1 && sceneById.has(scenePreds[0]!.id)) {
      row = sceneById.get(scenePreds[0]!.id)!;
    } else if (scenePreds.length > 1) {
      const sorted = [...scenePreds].sort(
        (a, b) => inferSceneSortIndex(a.data.label, a.data.purpose) - inferSceneSortIndex(b.data.label, b.data.purpose),
      );
      const pick = sorted[0]!;
      row = sceneById.get(pick.id) ?? gi;
    } else if (sceneTexts.length === 0) {
      row = gi;
    } else {
      row = Math.min(gi, sceneTexts.length - 1);
    }
    genByRow.set(g.id, row);
  }

  const rowCount = Math.max(sceneTexts.length, gensOrdered.length, 1);
  for (let r = 0; r < rowCount; r += 1) {
    const y = ySceneBase + r * rowStride;
    if (r < sceneTexts.length) {
      const st = sceneTexts[r]!;
      if (!placed.has(st.id)) {
        pos.set(st.id, { x: X_SCENE, y });
        placed.add(st.id);
      }
    }
  }

  for (const g of gensOrdered) {
    const r = genByRow.get(g.id) ?? 0;
    const y = ySceneBase + r * rowStride;
    pos.set(g.id, { x: X_GEN, y });
    placed.add(g.id);
  }

  for (const v of videoNodes) {
    const predGen = edges.find((e) => e.target === v.id && isGenToVideoImagePin(e, nById))?.source;
    let y = ySceneBase;
    if (predGen && genByRow.has(predGen)) {
      const r = genByRow.get(predGen)!;
      y = ySceneBase + r * rowStride;
    } else {
      y = ySceneBase + videoNodes.indexOf(v) * rowStride;
    }
    pos.set(v.id, { x: X_VIDEO, y });
    placed.add(v.id);
  }

  for (const c of composeNodes) {
    const outgoingGen = edges.find((e) => e.source === c.id && nById.get(e.target)?.data.kind === "generationBlock")
      ?.target;
    let y = ySceneBase;
    if (outgoingGen && genByRow.has(outgoingGen)) {
      y = ySceneBase + genByRow.get(outgoingGen)! * rowStride;
    }
    pos.set(c.id, { x: X_COMPOSE, y });
    placed.add(c.id);
  }

  const ysVideos = videoNodes.map((v) => pos.get(v.id)?.y ?? ySceneBase);
  const yJoin = ysVideos.length ? ysVideos.reduce((a, b) => a + b, 0) / ysVideos.length : ySceneBase;

  for (const j of joinNodes) {
    pos.set(j.id, { x: X_JOIN, y: yJoin });
    placed.add(j.id);
  }
  for (const o of outputNodes) {
    pos.set(o.id, { x: X_OUT, y: yJoin });
    placed.add(o.id);
  }

  const floatingImages = imageNodes.filter((im) => !placed.has(im.id));
  let yRefs = yGlobal + 40;
  for (const im of floatingImages.sort((a, b) => a.id.localeCompare(b.id))) {
    const targetGens = edges
      .filter((e) => e.source === im.id && isImageToGenRefPin(e, nById))
      .map((e) => e.target);
    let y = yRefs;
    if (targetGens.length === 1 && genByRow.has(targetGens[0]!)) {
      y = ySceneBase + genByRow.get(targetGens[0]!)! * rowStride;
    }
    pos.set(im.id, { x: X_SCENE - 20, y });
    placed.add(im.id);
    if (targetGens.length !== 1 || !genByRow.has(targetGens[0]!)) {
      yRefs += anchorForNode(im).h + STACK_GAP_Y;
    }
  }

  const orphans = nodes.filter((n) => !placed.has(n.id));
  if (orphans.length > 0) {
    return null;
  }

  return nodes.map((n) => {
    const p = pos.get(n.id)!;
    return { ...n, position: { ...p } };
  });
}

/**
 * Layer nodes by DAG depth (longest path from a source), then place each depth as one column:
 * nodes stack vertically and are centered around y = 0 using {@link NODE_ANCHOR} sizes.
 * Columns are spaced horizontally by {@link LAYOUT_COLUMN_GAP}.
 */
function layoutWorkflowNodesDepthColumns(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
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

/**
 * Prefer story-lane layout when the graph has image generation; otherwise depth columns.
 */
export function layoutWorkflowNodesCompactDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowNode[] {
  const story = tryLayoutWorkflowStoryAware(nodes, edges);
  if (story) return story;
  return layoutWorkflowNodesDepthColumns(nodes, edges);
}

export function topLeftForCenteredNode(
  center: { x: number; y: number },
  type: CanvasNodeType,
) {
  const { w, h } = NODE_ANCHOR[type];
  return { x: center.x - w / 2, y: center.y - h / 2 };
}
