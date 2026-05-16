import { NextResponse } from "next/server";
import { z } from "zod";
import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
} from "@/lib/workflow/schema";

const bodySchema = z.object({
  brief: z.string().min(1).max(4000),
});

/** Template expander — swap for a Fal-hosted LLM when you want real NL→graph. */
export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const brief = parsed.data.brief.trim();
  const lower = brief.toLowerCase();

  const textId = crypto.randomUUID();
  const fluxId = crypto.randomUUID();
  const nodes = [
    {
      id: textId,
      type: "textInput",
      position: { x: 0, y: 0 },
      data: {
        kind: "textInput" as const,
        label: "Text",
        value: brief,
      },
    },
    {
      id: fluxId,
      type: "falFluxSchnell",
      position: { x: 340, y: 0 },
      data: defaultNodeData("falFluxSchnell"),
    },
  ];

  const edges = [
    {
      id: `e-${textId}-${fluxId}`,
      source: textId,
      target: fluxId,
      sourceHandle: "text",
      targetHandle: "text",
    },
  ];

  const platform = (["youtube", "facebook", "instagram", "tiktok"] as const).find(
    (p) => lower.includes(p),
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
      brief.length > 48
        ? `AI draft · ${brief.slice(0, 45)}…`
        : `AI draft · ${brief || "Campaign"}`,
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };

  const validated = workflowDocumentSchema.safeParse(doc);
  if (!validated.success) {
    return NextResponse.json({ error: "Generated workflow failed validation" }, { status: 500 });
  }

  return NextResponse.json({ workflow: validated.data });
}
