import type { FalFluxPresetSize } from "@/lib/fal/text-to-image-config";
import type { WorkflowEdge, WorkflowNode } from "./schema";

type ExportPlatform = "youtube" | "facebook" | "instagram" | "tiktok";

/**
 * Best-effort Flux preset for a platform export (labels disambiguate IG Feed vs Stories).
 */
export function fluxPresetForExport(
  platform: ExportPlatform,
  label: string,
): FalFluxPresetSize {
  const l = label.toLowerCase();

  if (platform === "tiktok") return "portrait_16_9";
  if (platform === "youtube") return "landscape_16_9";

  if (/\b(story|stories|reels)\b/.test(l)) {
    return "portrait_16_9";
  }

  if (platform === "instagram") return "square_hd";

  return "landscape_4_3";
}

/** When one poster feeds multiple exports, pick one preset (vertical wins — others letterbox/crop in-channel). */
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

function targetPlatformExport(
  nodesById: Map<string, WorkflowNode>,
  nodeId: string,
): WorkflowNode | undefined {
  const n = nodesById.get(nodeId);
  return n?.data.kind === "platformExport" ? n : undefined;
}

/** Generation → export on the image lane (handles nullable legacy pins). */
function isGenerationToExportImageEdge(
  e: WorkflowEdge,
  genId: string,
  nodesById: Map<string, WorkflowNode>,
): boolean {
  if (e.source !== genId) return false;
  if (!targetPlatformExport(nodesById, e.target)) return false;
  const sh = e.sourceHandle ?? null;
  const th = e.targetHandle ?? null;
  const sourceIsImage = sh === null || sh === "image";
  const targetIsImage = th === null || th === "image";
  return sourceIsImage && targetIsImage;
}

export type ReconcileImageSizesOptions = {
  /** Stage/node ids to leave unchanged (planner set `settings.imageSize`). */
  skipNodeIds?: ReadonlySet<string>;
};

/**
 * Set each generation block's `imageSize` from downstream platform exports when it feeds them on the image pin.
 */
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

    const exports: WorkflowNode[] = [];
    for (const e of edges) {
      if (!isGenerationToExportImageEdge(e, node.id, byId)) continue;
      const t = byId.get(e.target);
      if (t?.data.kind === "platformExport") exports.push(t);
    }
    if (exports.length === 0) return node;

    const presets = exports.map((n) => {
      if (n.data.kind !== "platformExport") return "square_hd";
      return fluxPresetForExport(n.data.platform, n.data.label);
    });
    const imageSize = unifyFluxPresetsForSharedCreative(presets);
    if (node.data.imageSize === imageSize) return node;
    return { ...node, data: { ...node.data, imageSize } };
  });
}
