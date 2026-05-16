import { z } from "zod";

import {
  WORKFLOW_DOCUMENT_VERSION,
  workflowDocumentSchema,
  type WorkflowDocument,
} from "./schema";

const AGENT_DRAFT_SCHEMA = z.object({
  name: z.string().min(1),
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
});

const SYSTEM = `You design directed acyclic workflow graphs for a marketing creative tool.

Return ONLY valid JSON (no markdown) with this shape:
{
  "name": "short campaign title",
  "nodes": [ ... ],
  "edges": [ ... ]
}

Rules:
- The graph must be ONE connected component, acyclic, left-to-right flow.
- Node types (field type AND data.kind): "mediaInput", "falFluxSchnell", "platformExport".

mediaInput node:
  "type": "mediaInput", "position": {"x": number, "y": number},
  "data": { "kind": "mediaInput", "label": string, "value": string (creative brief / prompt text), "images": [], "videos": [] }

falFluxSchnell node:
  "type": "falFluxSchnell", "position": {"x": number, "y": number},
  "data": { "kind": "falFluxSchnell", "label": string, "suffix": string (style appended to upstream text), "imageSize": "square_hd"|"landscape_4_3"|"portrait_4_3", "numInferenceSteps": 1-12 }

platformExport node:
  "type": "platformExport", "position": {"x": number, "y": number},
  "data": { "kind": "platformExport", "label": string, "platform": "youtube"|"facebook"|"instagram"|"tiktok", "metaPageId": optional string when facebook or instagram }

Edges (each needs unique string id):
  { "id": string, "source": nodeId, "target": nodeId, "sourceHandle": null|string, "targetHandle": null|"text"|"image"|"video" }

Handle wiring:
- Into falFluxSchnell: use targetHandle "text". Source is usually mediaInput (sourceHandle null).
- Into platformExport: wire mediaInput copy with targetHandle "text"; wire falFluxSchnell image with sourceHandle "image" and targetHandle "image".
- For YouTube video uploads later: optionally wire mediaInput early if user supplied remote video URL in value — normally skip video handle unless the brief explicitly mentions an https video asset.

Typical 3-node pipeline x positions ~0, 320, 640. Use varied y only if multiple branches.

Prefer including platformExport when the user names a destination (YouTube, Instagram, Facebook, TikTok).`;

function parseJsonFromAssistantContent(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  const inner = fence?.[1]?.trim() ?? trimmed;
  return JSON.parse(inner) as unknown;
}

function draftToDocument(draft: z.infer<typeof AGENT_DRAFT_SCHEMA>): WorkflowDocument | null {
  const doc = {
    id: crypto.randomUUID(),
    name: draft.name.trim().slice(0, 160),
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: draft.nodes,
    edges: draft.edges,
    updatedAt: new Date().toISOString(),
  };
  const validated = workflowDocumentSchema.safeParse(doc);
  return validated.success ? validated.data : null;
}

export async function generateWorkflowWithOpenAI(userPrompt: string): Promise<WorkflowDocument | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) return null;

  const model = process.env.OPENAI_WORKFLOW_MODEL?.trim() || "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Build a workflow for this campaign request:\n\n${userPrompt.trim().slice(0, 6000)}`,
        },
      ],
      temperature: 0.35,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${t.slice(0, 280)}`);
  }

  const payload = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI returned no message content");
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromAssistantContent(content);
  } catch {
    return null;
  }

  const draft = AGENT_DRAFT_SCHEMA.safeParse(parsed);
  if (!draft.success) return null;

  return draftToDocument(draft.data);
}
