import type { CanvasNodeType } from "@/lib/workflow/schema";

/** Legacy edges from the single-pin mediaInput used null sourceHandle (full bundle). */
export function sourceMediaLane(
  sourceType: string,
  sourceHandle: string | null | undefined,
): "text" | "image" | "wildcard" {
  if (sourceType === "generationBlock") {
    if (sourceHandle === "text") return "text";
    if (sourceHandle === "image") return "image";
    return "wildcard";
  }
  if (sourceType === "mediaInput") {
    if (sourceHandle === "text") return "text";
    if (sourceHandle === "image") return "image";
    return "wildcard";
  }
  return "wildcard";
}

function targetMediaLane(
  targetType: string,
  targetHandle: string | null | undefined,
): "text" | "image" | null {
  if (targetType === "generationBlock") {
    if (targetHandle === "text" || targetHandle == null) return "text";
    if (targetHandle === "image") return "image";
    return null;
  }
  if (targetType === "platformExport") {
    if (targetHandle === "text" || targetHandle == null) return "text";
    if (targetHandle === "image") return "image";
    return null;
  }
  return null;
}

/** Returns whether a new edge is allowed (matching pin colors / semantic lanes). */
export function areWorkflowHandlesCompatible(
  sourceType: CanvasNodeType | string,
  sourceHandle: string | null | undefined,
  targetType: CanvasNodeType | string,
  targetHandle: string | null | undefined,
): boolean {
  const sl = sourceMediaLane(String(sourceType), sourceHandle ?? null);
  const tl = targetMediaLane(String(targetType), targetHandle ?? null);
  if (tl === null) return false;
  if (sl === "wildcard") return true;
  return sl === tl;
}
