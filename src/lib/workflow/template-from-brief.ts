import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
  type WorkflowDocument,
} from "./schema";

function briefWantsVideo(lower: string): boolean {
  return (
    /\b(short film|music video|promo video)\b/.test(lower) ||
    /\b(movies?|films?|videos?|clips?|trailer|reels?|cinematic|footage)\b/.test(lower)
  );
}

/** YouTube video: look-reference image → image-to-video (matches AI agent two-block recommendation). */
export function buildYoutubeLookRefThenVideoTemplate(
  trimmed: string,
  platform: "youtube",
): WorkflowDocument {
  const base = defaultNodeData("generationBlock");
  const lookData = {
    ...base,
    label: "Look reference",
    suffix:
      ", neutral hero framing, identity and wardrobe clarity, consistent lighting and palette; still pose, no action beat",
    imageSize: "landscape_16_9" as const,
    numInferenceSteps: 2,
  };
  const motionData = {
    ...base,
    label: "Motion / video",
    suffix:
      ", cinematic camera and motion, short-form pacing, polished grade; audio and atmos aligned to the brief",
    imageSize: "landscape_16_9" as const,
    videoDuration: "6s" as const,
    videoResolution: "1080p" as const,
    wanDurationSec: 6,
    wanResolution: "1080p" as const,
  };

  const textId = crypto.randomUUID();
  const lookId = crypto.randomUUID();
  const motionId = crypto.randomUUID();
  const exportId = crypto.randomUUID();

  const nodes: WorkflowDocument["nodes"] = [
    {
      id: textId,
      type: "mediaInput",
      position: { x: 0, y: 0 },
      data: {
        kind: "mediaInput",
        label: "Campaign input",
        value: trimmed,
        images: [],
        videos: [],
      },
    },
    {
      id: lookId,
      type: "generationBlock",
      position: { x: 340, y: 0 },
      data: lookData,
    },
    {
      id: motionId,
      type: "generationBlock",
      position: { x: 680, y: 0 },
      data: motionData,
    },
    {
      id: exportId,
      type: "platformExport",
      position: { x: 1020, y: 0 },
      data: {
        kind: "platformExport",
        label: `${platform} export`,
        platform,
      },
    },
  ];

  const edges: WorkflowDocument["edges"] = [
    {
      id: `e-${textId}-${lookId}-t`,
      source: textId,
      target: lookId,
      sourceHandle: "text",
      targetHandle: "text",
    },
    {
      id: `e-${lookId}-${motionId}-i`,
      source: lookId,
      target: motionId,
      sourceHandle: "image",
      targetHandle: "image",
    },
    {
      id: `e-${textId}-${motionId}-t`,
      source: textId,
      target: motionId,
      sourceHandle: "text",
      targetHandle: "text",
    },
    {
      id: `e-${motionId}-${exportId}-v`,
      source: motionId,
      target: exportId,
      sourceHandle: "video",
      targetHandle: "video",
    },
    {
      id: `e-${lookId}-${exportId}-i`,
      source: lookId,
      target: exportId,
      sourceHandle: "image",
      targetHandle: "image",
    },
    {
      id: `e-${textId}-${exportId}-t`,
      source: textId,
      target: exportId,
      sourceHandle: "text",
      targetHandle: "text",
    },
  ];

  const doc = {
    id: crypto.randomUUID(),
    name:
      trimmed.length > 48 ? `Draft · ${trimmed.slice(0, 45)}…` : `Draft · ${trimmed || "Campaign"}`,
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };

  const validated = workflowDocumentSchema.safeParse(doc);
  if (!validated.success) {
    throw new Error("Template workflow failed validation");
  }
  return validated.data;
}

/** Deterministic graph from a brief (keywords choose export platform and video vs image). */
export function buildTemplateWorkflowDocument(brief: string): WorkflowDocument {
  const trimmed = brief.trim();
  const lower = trimmed.toLowerCase();

  const platform =
    (["youtube", "facebook", "instagram", "tiktok"] as const).find((p) => lower.includes(p)) ??
    "youtube";

  const wantsVideo = briefWantsVideo(lower);
  /** YouTube export accepts MP4; Meta/TikTok bundle paths expect an image from the image pin. */
  const useVideoPin = wantsVideo && platform === "youtube";

  if (useVideoPin) {
    return buildYoutubeLookRefThenVideoTemplate(trimmed, platform);
  }

  const baseGen = defaultNodeData("generationBlock");
  const genData = {
    ...baseGen,
    label: "Generate image",
    suffix: wantsVideo
      ? ", cinematic key visual, film still, high quality ad creative"
      : ", high quality ad creative, clean composition",
    ...(wantsVideo ? { imageSize: "landscape_16_9" as const } : {}),
  };

  const textId = crypto.randomUUID();
  const fluxId = crypto.randomUUID();
  const exportId = crypto.randomUUID();

  const nodes: WorkflowDocument["nodes"] = [
    {
      id: textId,
      type: "mediaInput",
      position: { x: 0, y: 0 },
      data: {
        kind: "mediaInput",
        label: "Campaign input",
        value: trimmed,
        images: [],
        videos: [],
      },
    },
    {
      id: fluxId,
      type: "generationBlock",
      position: { x: 340, y: 0 },
      data: genData,
    },
    {
      id: exportId,
      type: "platformExport",
      position: { x: 680, y: 0 },
      data: {
        kind: "platformExport",
        label: `${platform} export`,
        platform,
      },
    },
  ];

  const mediaToGen = {
    id: `e-${textId}-${fluxId}`,
    source: textId,
    target: fluxId,
    sourceHandle: "text",
    targetHandle: "text",
  } as const;

  const mediaToExport = {
    id: `e-${textId}-${exportId}`,
    source: textId,
    target: exportId,
    sourceHandle: "text",
    targetHandle: "text",
  } as const;

  const genToExport = {
    id: `e-${fluxId}-${exportId}`,
    source: fluxId,
    target: exportId,
    sourceHandle: "image",
    targetHandle: "image",
  } as const;

  const edges: WorkflowDocument["edges"] = [mediaToGen, mediaToExport, genToExport];

  const doc = {
    id: crypto.randomUUID(),
    name:
      trimmed.length > 48 ? `Draft · ${trimmed.slice(0, 45)}…` : `Draft · ${trimmed || "Campaign"}`,
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };

  const validated = workflowDocumentSchema.safeParse(doc);
  if (!validated.success) {
    throw new Error("Template workflow failed validation");
  }
  return validated.data;
}
