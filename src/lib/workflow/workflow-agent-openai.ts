import OpenAI, { APIError } from "openai";
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
- Text→image runs on the server via fal; default model is fal-ai/flux/schnell (~$0.003/megapixel on fal, typically the cheapest Flux text→image tier this stack supports). Override with env FAL_TEXT_TO_IMAGE_MODEL if needed.

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

/** Default snapshot alias; override with OPENAI_WORKFLOW_MODEL. */
const DEFAULT_WORKFLOW_MODEL = "gpt-5.4-mini";

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

export type WorkflowAgentDialogTurn = {
  role: "user" | "assistant";
  content: string;
};

function compactDialog(dialog: WorkflowAgentDialogTurn[]): WorkflowAgentDialogTurn[] {
  const maxChars = 12_000;
  const out: WorkflowAgentDialogTurn[] = [];
  let used = 0;
  for (let i = dialog.length - 1; i >= 0; i -= 1) {
    const t = dialog[i]!;
    const content = t.content.trim().slice(0, 6000);
    used += content.length;
    if (used > maxChars) break;
    out.push({ role: t.role, content });
  }
  return out.reverse();
}

/** Wrap a single prompt the same way the legacy `/api/workflow/agent` body `{ prompt }` did. */
export function workflowAgentLegacyUserContent(prompt: string): string {
  return `Build a workflow for this campaign request:\n\n${prompt.trim().slice(0, 6000)}`;
}

/** Build or refine a workflow from prior chat turns ending in a user message. */
export async function generateWorkflowWithOpenAI(
  dialog: WorkflowAgentDialogTurn[],
): Promise<WorkflowDocument | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;

  const model = process.env.OPENAI_WORKFLOW_MODEL?.trim() || DEFAULT_WORKFLOW_MODEL;

  const trimmedDialog = compactDialog(dialog);
  if (trimmedDialog.length === 0) return null;
  const last = trimmedDialog[trimmedDialog.length - 1]!;
  if (last.role !== "user") return null;

  const client = new OpenAI({ apiKey: key });

  let content: string;
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: SYSTEM }, ...trimmedDialog],
      response_format: { type: "json_object" },
      temperature: 0.35,
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw || typeof raw !== "string") {
      throw new Error("OpenAI returned no message content");
    }
    content = raw;
  } catch (err) {
    if (err instanceof APIError) {
      const detail =
        typeof err.message === "string" ? err.message : String(err).slice(0, 280);
      throw new Error(`OpenAI error ${err.status ?? "?"}: ${detail}`);
    }
    throw err;
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
