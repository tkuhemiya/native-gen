import type { CanvasNodeType } from "@/lib/workflow/schema";

type SourceLane = "text" | "image" | "video" | "wildcard";
type TargetLane = "text" | "image" | "video" | "media" | null;

/** Legacy edges from the single-pin mediaInput used null sourceHandle (full bundle). */
export function sourceMediaLane(
  sourceType: string,
  sourceHandle: string | null | undefined,
): SourceLane {
  if (sourceType === "generationBlock") {
    if (sourceHandle === "text") return "text";
    if (sourceHandle === "image") return "image";
    return "wildcard";
  }
  if (sourceType === "videoBlock") {
    if (sourceHandle === "video") return "video";
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
): TargetLane {
  if (targetType === "generationBlock") {
    if (targetHandle === "text" || targetHandle == null) return "text";
    if (targetHandle === "image") return "image";
    return null;
  }
  if (targetType === "videoBlock") {
    if (targetHandle === "image") return "image";
    if (targetHandle === "text") return "text";
    return null;
  }
  if (targetType === "platformExport") {
    if (targetHandle === "text" || targetHandle == null) return "text";
    if (targetHandle === "image") return "media";
    return null;
  }
  return null;
}

/**
 * Returns whether a new edge is allowed (matching pin colors / semantic lanes).
 *
 * Special case: `platformExport`'s blue (image) input is treated as a generic media lane and
 * accepts both `image` and `video` sources, so a downstream export can publish either an image
 * or an animated clip from the same handle.
 */
export function areWorkflowHandlesCompatible(
  sourceType: CanvasNodeType | string,
  sourceHandle: string | null | undefined,
  targetType: CanvasNodeType | string,
  targetHandle: string | null | undefined,
): boolean {
  const sl = sourceMediaLane(String(sourceType), sourceHandle ?? null);
  const tl = targetMediaLane(String(targetType), targetHandle ?? null);
  if (tl === null) return false;
  if (sl === "wildcard") {
    if (tl === "media") return true;
    return tl === "text" || tl === "image";
  }
  if (tl === "media") return sl === "image" || sl === "video";
  return sl === tl;
}
