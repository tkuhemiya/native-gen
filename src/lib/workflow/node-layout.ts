import type { CanvasNodeType } from "@/lib/workflow/schema";

/**
 * Approximate node size for centering new blocks on the cursor (flow coords use top-left).
 */
export const NODE_ANCHOR: Record<CanvasNodeType, { w: number; h: number }> = {
  mediaInput: { w: 280, h: 312 },
  falFluxSchnell: { w: 300, h: 210 },
  platformExport: { w: 260, h: 320 },
};

export function topLeftForCenteredNode(
  center: { x: number; y: number },
  type: CanvasNodeType,
) {
  const { w, h } = NODE_ANCHOR[type];
  return { x: center.x - w / 2, y: center.y - h / 2 };
}
