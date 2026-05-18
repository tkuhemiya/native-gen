import type { FalFluxPresetSize } from "@/lib/fal/text-to-image-config";
import type { WorkflowEdge, WorkflowNode } from "./schema";

/** Short-story friendly default when feeding an output preview block. */
export function fluxPresetForOutput(label: string): FalFluxPresetSize {
  const l = label.toLowerCase();
  if (/\b(film|movie|cinematic|horizontal)\b/.test(l)) return "landscape_16_9";
  if (/\b(square|thumbnail)\b/.test(l)) return "square_hd";
  return "portrait_16_9";
}

/** When one poster feeds multiple outputs, pick one preset (vertical wins). */
export function unifyFluxPresetsForSharedCreative(
  presets: FalFluxPresetSize[],
): FalFluxPresetSize {
  const u = [...new Set(presets)];
  if (u.length <= 1) return u[0] ?? "square_hd";
  if (u.includes("portrait_16_9")) return "portrait_16_9";
  if (u.includes("square_hd")) return "square_hd";
  if (u.includes("landscape_16_9")) return "landscape_16_9";
  return u.sort()[0]!;
}

function targetOutputBlock(
  nodesById: Map<string, WorkflowNode>,
  nodeId: string,
): WorkflowNode | undefined {
  const n = nodesById.get(nodeId);
  return n?.data.kind === "outputBlock" ? n : undefined;
}

/** Generation → output preview on the media lane. */
function isGenerationToOutputMediaEdge(
  e: WorkflowEdge,
  genId: string,
  nodesById: Map<string, WorkflowNode>,
): boolean {
  if (e.source !== genId) return false;
  if (!targetOutputBlock(nodesById, e.target)) return false;
  const sh = e.sourceHandle ?? null;
  const th = e.targetHandle ?? null;
  const sourceIsImage = sh === null || sh === "image";
  const targetIsMedia = th === null || th === "media";
  return sourceIsImage && targetIsMedia;
}

export type ReconcileImageSizesOptions = {
  skipNodeIds?: ReadonlySet<string>;
};

export function reconcileGenerationImageSizes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options: ReconcileImageSizesOptions = {},
): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const skip = options.skipNodeIds ?? new Set<string>();

  return nodes.map((node) => {
    if (node.data.kind !== "generationBlock") return node;
    if (skip.has(node.id)) return node;

    const outputs: WorkflowNode[] = [];
    for (const e of edges) {
      if (!isGenerationToOutputMediaEdge(e, node.id, byId)) continue;
      const t = byId.get(e.target);
      if (t?.data.kind === "outputBlock") outputs.push(t);
    }
    if (outputs.length === 0) return node;

    const presets = outputs.map((n) => {
      if (n.data.kind !== "outputBlock") return "square_hd";
      return fluxPresetForOutput(n.data.label);
    });
    const imageSize = unifyFluxPresetsForSharedCreative(presets);
    if (node.data.imageSize === imageSize) return node;
    return { ...node, data: { ...node.data, imageSize } };
  });
}
