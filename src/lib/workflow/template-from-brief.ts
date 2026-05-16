import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
  type WorkflowDocument,
} from "./schema";

/** Deterministic graph from a brief (keywords choose export platform). Photo generation only. */
export function buildTemplateWorkflowDocument(brief: string): WorkflowDocument {
  const trimmed = brief.trim();
  const lower = trimmed.toLowerCase();

  const platform =
    (["youtube", "facebook", "instagram", "tiktok"] as const).find((p) => lower.includes(p)) ??
    "youtube";

  const baseGen = defaultNodeData("generationBlock");
  const genData = {
    ...baseGen,
    label: "Generate image",
    suffix: ", high quality ad creative, clean composition",
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
        label: "Brief / posts",
        value: trimmed,
        images: [],
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
