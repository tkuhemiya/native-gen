type SourceLane = "text" | "image" | "video" | "wildcard";
type TargetLane = "text" | "image" | "video" | "media" | null;

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
  if (sourceType === "textPrimitive" || sourceType === "textLiteral") {
    if (sourceHandle === "text") return "text";
    return "wildcard";
  }
  if (sourceType === "imagePrimitive" || sourceType === "imageLiteral") {
    if (sourceHandle === "image") return "image";
    return "wildcard";
  }
  if (sourceType === "sceneCompose") {
    if (sourceHandle === "script") return "text";
    if (sourceHandle === "imageA" || sourceHandle === "imageB") return "image";
    return "wildcard";
  }
  if (sourceType === "sceneJoin") {
    if (sourceHandle === "video") return "video";
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
  if (targetType === "textPrimitive") {
    if (targetHandle === "text" || targetHandle == null) return "text";
    return null;
  }
  if (targetType === "textLiteral") {
    return null;
  }
  if (targetType === "imagePrimitive") {
    if (targetHandle === "text") return "text";
    if (targetHandle === "image") return "image";
    return null;
  }
  if (targetType === "imageLiteral") {
    return null;
  }
  if (targetType === "sceneCompose") {
    if (targetHandle === "script") return "text";
    if (targetHandle === "imageA" || targetHandle === "imageB") return "image";
    return null;
  }
  if (targetType === "sceneJoin") {
    if (targetHandle === "clips" || targetHandle == null) return "video";
    return null;
  }
  if (targetType === "outputBlock") {
    if (targetHandle === "media" || targetHandle == null) return "media";
    return null;
  }
  return null;
}

export function areWorkflowHandlesCompatible(
  sourceType: string,
  sourceHandle: string | null | undefined,
  targetType: string,
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
