import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
  type WorkflowDocument,
} from "./schema";

/** Deterministic graph from a brief (keywords choose export platform). */
export function buildTemplateWorkflowDocument(brief: string): WorkflowDocument {
  const trimmed = brief.trim();
  const lower = trimmed.toLowerCase();

  const textId = crypto.randomUUID();
  const fluxId = crypto.randomUUID();
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
      type: "falFluxSchnell",
      position: { x: 340, y: 0 },
      data: defaultNodeData("falFluxSchnell"),
    },
  ];

  const edges: WorkflowDocument["edges"] = [
    {
      id: `e-${textId}-${fluxId}`,
      source: textId,
      target: fluxId,
      sourceHandle: "text",
      targetHandle: "text",
    },
  ];

  const platform = (["youtube", "facebook", "instagram", "tiktok"] as const).find((p) =>
    lower.includes(p),
  );

  if (platform) {
    const exportId = crypto.randomUUID();
    nodes.push({
      id: exportId,
      type: "platformExport",
      position: { x: 680, y: 0 },
      data: {
        kind: "platformExport",
        label: `${platform} export`,
        platform,
      },
    });
    edges.push({
      id: `e-${textId}-${exportId}`,
      source: textId,
      target: exportId,
      sourceHandle: "text",
      targetHandle: "text",
    });
    edges.push({
      id: `e-${fluxId}-${exportId}`,
      source: fluxId,
      target: exportId,
      sourceHandle: "image",
      targetHandle: "image",
    });
  }

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
