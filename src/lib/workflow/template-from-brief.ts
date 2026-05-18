import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
  type NodeData,
  type WorkflowDocument,
} from "./schema";

/** Minimal starter DAG for short-story workflows (seed text → still → preview). */
export function buildTemplateWorkflowDocument(brief: string): WorkflowDocument {
  const trimmed = brief.trim();

  const baseGen = defaultNodeData("generationBlock");
  const genData = {
    ...baseGen,
    label: "Establishing still",
    suffix:
      ", cinematic establishing shot for a literary short story, cohesive mood and composition",
  };

  const textId = crypto.randomUUID();
  const fluxId = crypto.randomUUID();
  const exportId = crypto.randomUUID();

  const seed = defaultNodeData("textPrimitive") as Extract<NodeData, { kind: "textPrimitive" }>;
  const nodes: WorkflowDocument["nodes"] = [
    {
      id: textId,
      type: "textPrimitive",
      position: { x: 0, y: 0 },
      data: {
        ...seed,
        label: "Story seed",
        value: trimmed,
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
      type: "outputBlock",
      position: { x: 680, y: 0 },
      data: {
        kind: "outputBlock",
        label: "Preview · export",
      },
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
    {
      id: `e-${fluxId}-${exportId}`,
      source: fluxId,
      target: exportId,
      sourceHandle: "image",
      targetHandle: "media",
    },
  ];

  const doc = {
    id: crypto.randomUUID(),
    name:
      trimmed.length > 48 ? `Draft · ${trimmed.slice(0, 45)}…` : `Draft · ${trimmed || "Story"}`,
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
