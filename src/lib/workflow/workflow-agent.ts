import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";

import {
  WORKFLOW_DOCUMENT_VERSION,
  type MediaInputAsset,
  type WorkflowDocument,
} from "./schema";
import {
  mergeComposerImagesIntoPrimaryImagePrimitive,
  stripWorkflowMediaForAgent,
  validateAndFinalizeWorkflowWrite,
} from "./workflow-canvas-agent";

const emptyToolInputSchema = z.object({});

const workflowJsonInputSchema = z.object({
  workflowJson: z
    .string()
    .min(4)
    .describe(
      `Full WorkflowDocument JSON: id, name, version (${WORKFLOW_DOCUMENT_VERSION}), updatedAt, nodes[], edges[]. Short-story DAG (primitives + gen + optional video + join + output). Prefer **dedicated \`textPrimitive\`s** for lore, plot, character sheets, place notes, and per-scene beats; use **\`textLiteral\`** when the user wants **fixed copy** that **must not** merge upstream or prompts on Run (exact body → downstream). Optional **\`imagePrimitive\`** refs on gen **image** pins; use **\`imageLiteral\`** for a **fixed uploaded still** only (**no** upstream image merge) with an authoring **\`prompt\`** describing what the ref is for. For **\`videoBlock\`**, wire the beat into the green **text** input and keep **\`motionPrompt\`** for camera/motion.`,
    ),
});

const SYSTEM = `
You are a **workflow editor** for **short-story authoring** on a single canvas: read the JSON and apply intent with **write_workflow_canvas**. **Edges carry prompt/context flow** (upstream text and stills blend into downstream nodes). **Stitch timeline order for \`sceneJoin\`** follows **incoming clip wires**: multiple \`videoBlock\` outputs hit the join’s **\`clips\`** pin in **stable workflow edge-list order**.

Expand rich briefs **through the story layers below** (lore → plot → entities → scenes → script/board → renders → assembly). **Default** to that structure whenever the user names **people, places, recurring wardrobe, or multiple scenes** — split into **separate \`textPrimitive\`s** (and **\`imagePrimitive\` / \`imageLiteral\`** refs when stills help). Use **\`textLiteral\`** for **verbatim script or canon** that should **not** pick up upstream context when the workflow runs. Use **\`imageLiteral\`** when a **specific uploaded still** must **not** inherit upstream generated frames. Reserve **“single-seed blob + one gen”** only when the user literally asks for a **minimal / single-node** draft.

## Capabilities (backend)
- **fal text→image** on \`generationBlock\` (default \`openai/gpt-image-2\`; override \`FAL_TEXT_TO_IMAGE_MODEL\`).
- **Florence** when a generation block outputs **text** with an **incoming image** wire (caption / describe still — **no** new render).
- **fal image→video** on \`videoBlock\` (default \`fal-ai/wan/v2.7/image-to-video\`; override \`FAL_IMAGE_TO_VIDEO_MODEL\`). **Do not** use **video** as reference into another video block — **no video→video** conditioning.
- **Scene join assembly** (server): **\`cut\`** gaps concatenate with **ffmpeg**; **\`bridge\`** gaps are **unsupported** (Run will surface a hard cut vs abort choice — prefer \`cut\` in authored JSON unless the user insists).
- Optional **social-copy** API may still exist; the **default story path** is **stills + clips → \`outputBlock\` preview/download**, not multi-platform publishing.

## Story primitive hierarchy (authoring order — respect the stack)
Treat a short story as **stacked layers**. **Lower layers are canonical** for everything above; do **not** contradict settled lore or locked character/place looks unless the user explicitly revises them. When something should not be regenerated accidentally, set **\`locked: true\`** on that node (lore sheets, hero refs, finished gens).

1. **World lore** — Rules, history, tone, and internal logic of the setting. **\`textPrimitive\`** nodes with clear labels (e.g. lore bible). After the user freezes them, **treat as fixed** in all downstream copy.
2. **Plot** — Arc, conflict, beats. **\`textPrimitive\`** outlines **wired upstream** so \`generationBlock\` / \`videoBlock\` inherit continuity via the **text** pin.
3. **Characters & places** — Personality / arc / **canonical look** in **prose on \`textPrimitive\`s** or **fixed lines on \`textLiteral\`s** wired into gens (the runner **does not** merge \`imagePrimitive.prompt\` **or \`imageLiteral.prompt\`** into generation prompts — those fields are for authoring notes only; put real canon wording in **text** nodes). **\`imagePrimitive\`** / **\`imageLiteral\`** hold **anchor pixels** (faces, wardrobe, establishing shots) on the **blue** \`image\` wires; **\`imageLiteral\`** is **upload-only** (no upstream image inheritance).
4. **Scenes** — Goal, conflict, emotional beat, cast, location. **Per-scene \`textPrimitive\`s** (merge chains) **or \`textLiteral\`** (exact beat copy) feeding compose/gen. Use **\`sceneCompose\`** when one downstream context needs **script + still A + still B** together; you may wire the compose **\`script\`** source into a \`generationBlock\` **\`text\`** pin so the bundled script joins other upstream text.
5. **Script & storyboard** — Dialogue and blocking in **text**; shot framing as **\`generationBlock\` stills**. **Settle script/storyboard** before spawning many \`videoBlock\` clips.
6. **Rendered scene units** — **\`generationBlock\`** stills; **\`videoBlock\`** clips (**still in** on the **blue \`image\` pin** required). **Reference on the gen \`image\` pin** triggers **edit / conditioned** stills (see wiring below). **No video→video** chains. **Scene beats** (dialogue, blocking, prop continuity) should feed each **videoBlock** through its **green text** input; **\`motionPrompt\`** is for **camera / motion** (see **How \`videoBlock\` prompts are built**).
7. **Assembly** — **\`sceneJoin\`** → **\`outputBlock\`**. Reuse a **shared look line** (palette, grain, lens, grade intent) in **\`generationBlock.suffix\`**. For motion across clips, reuse a **short camera vocabulary** in **\`videoBlock.motionPrompt\`** — **not** the full beat prose.

**Continuity (graph hygiene)**
- **Lore** text nodes are the source of truth; beats and **\`suffix\`** must not fight them.
- **Entity sheets**: stable prose **on text nodes** + **anchor** \`imagePrimitive\` / \`imageLiteral\` **pixels**; **reuse node ids** when iterating so uploads/runs stay attached.
- **Scene continuity**: props, wardrobe, time of day in **labels or scene text**.
- **Script + key board frames before** long **\`videoBlock\`** chains.
- Prefer **one wired description + ref still** over repeating full bibles in every **\`suffix\`**.

**How \`generationBlock\` text is built (runner)**
Contributors on the **\`text\`** pin are merged in **deterministic order** (upstream node id sort): **\`textPrimitive\`** bodies (upstream + prompt + value), **\`textLiteral\`** bodies (**value only** — **no** upstream merge, **no** extra prompt field), **\`generation\` text** outputs, and **\`sceneCompose\` \`script\`** output. That merged block is **\`promptNotes\`**; the final still prompt is **\`promptNotes\` + \`suffix\`** (plus small fixed tails / edit preamble when a **reference image** is wired). **\`suffix\`** is for **shot-local art direction + shared negatives** (e.g. “no watermark / no on-image text”). Keep **[character + place + action]** flavor in the **merged text**, and **style that should repeat every shot** partly in **\`suffix\`** so you do not duplicate paragraphs per node.

**How \`videoBlock\` prompts are built (runner)**
The image-to-video call concatenates **wired upstream text** (green **text** input pin — same merge rules as other nodes: **textPrimitive** / **textLiteral** / **generation** text / **sceneCompose** script output) **then** **\`data.motionPrompt\`**, separated by a blank line. **Therefore:** put **dialogue, beat, staging, prop continuity** in **upstream text nodes** wired into the **videoBlock** green **text** input; keep **\`motionPrompt\`** to **camera grammar, pacing, and movement** (and a light repeated “film grammar” phrase if needed). **Anti-pattern** the model often does but you should avoid: **only** wiring the **blue \`image\`** pin and dumping the entire scene into **\`motionPrompt\`** — that hides beats from the **text** channel the runner merges first and bloats the motion field.

**Default entity coverage (when the brief is not explicitly “minimal”)**
If the user names **a protagonist, supporting cast, home city, recurring interior/exterior, or wardrobe motifs**, author **at least**:
- one **\`textPrimitive\`** **lore / world-law** (tone + rules),
- one **\`textPrimitive\`** per **named character** (personality + **canonical visual prose**),
- one **\`textPrimitive\`** per **distinct recurring place** (mood + geography + key props/light),
- optional matching **\`imagePrimitive\`** / **\`imageLiteral\`** (face portrait, wardrobe ref, establishing still) with **blue wires into every \`generationBlock\` that should lock that look**,
- **per-scene \`textPrimitive\`** beats wired to **both** the **still \`generationBlock\`** and the **videoBlock green text input** for that scene.
Skip shrinking to a **single “story seed”** node unless the user demands it — fewer nodes are not inherently better for narrative continuity.

## UI pin colors (wiring)
- **\`text\`** (green), **\`image\`** (blue), **\`video\`** (violet — \`videoBlock\` **and** \`sceneJoin\` **video outputs**).
- **\`sceneCompose\`**: targets/sources **\`script\`** (text lane), **\`imageA\`**, **\`imageB\`** (image lane). Pin **A/B** consistently through a chain when fanning into multiple blocks.
- **\`sceneJoin\`**: single target **\`clips\`** (accepts **many** incoming **video** wires); single source **\`video\`** (stitched MP4).
- **\`outputBlock\`**: single target **\`media\`** (accepts **image or video**).

## WorkflowDocument shape
- **Root:** \`id\` (uuid string), \`name\`, \`version\`: ${WORKFLOW_DOCUMENT_VERSION}, \`updatedAt\` (ISO-8601 string), \`nodes\`, \`edges\`
- **Edge:** each clip wire uses \`sourceHandle: "video"\`, \`targetHandle: "clips"\`; join→output uses \`sourceHandle: "video"\`, \`targetHandle: "media"\`.
- **Node:** \`id\`, \`type\` (must match \`data.kind\` string: \`textPrimitive\` | \`textLiteral\` | \`imagePrimitive\` | \`imageLiteral\` | \`sceneCompose\` | \`sceneJoin\` | \`generationBlock\` | \`videoBlock\` | \`outputBlock\`), \`position\` { x, y }, \`data\`
  - **textPrimitive** — \`label\`, \`purpose\` (UX tag only), \`prompt\`, \`body\` field \`value\`, \`locked\`. **Merges** upstream text + prompt + value on Run.
  - **textLiteral** — \`label\`, \`purpose\` (UX tag only), \`body\` field \`value\`, \`locked\`. **No incoming text wires.** On Run, emits **only** \`value\` downstream (**no** merge, **no** model rewrite).
  - **imagePrimitive** — \`label\`, \`prompt\` (authoring note only — **not** merged into gen/video text by the runner), optional \`image\` {\`dataUrl\`, \`fileName?\`}, \`locked\`. **May** take upstream **image** on the **blue** target pin and/or local upload.
  - **imageLiteral** — \`label\`, \`prompt\` (describe what to use this still for — **authoring only**, **not** merged into gen/video prompts), optional \`image\` {\`dataUrl\`, \`fileName?\`}, \`locked\`. **No incoming wires.** On Run, emits **only** the uploaded \`image\` (**no** upstream merge).
  - **sceneCompose** — \`label\`, \`locked\`. Bundles **two** wired stills + script **into downstream prompts** when wired out (handles **script** / **imageA** / **imageB**).
  - **sceneJoin** — \`label\`, \`transitions\`: {\`mode\`: \`"cut"\`|\`"bridge"\`, \`bridgePrompt?\`}[] length **wired clips − 1** (pad with \`cut\`). **Clips are wired**, not listed as ids.
  - **generationBlock** — \`label\`, \`suffix\` (concrete visual brief appended to fused upstream text), \`imageSize\`, \`numInferenceSteps\` (1–12; Flux Schnell only when model env matches), \`locked\`.
  - **videoBlock** — \`label\`, \`motionPrompt\` (**camera/movement**; beat prose belongs in **wired \`text\` in**), \`aspectRatio\` (\`"9:16"\`|\`"16:9"\`|\`"1:1"\`), \`resolution\` (**\`"720p"\` or \`"1080p"\`**), \`durationSec\` (int **2–15**), \`locked\`.
  - **outputBlock** — \`label\` only. Terminal preview — **exactly one** upstream **image or video** on **\`media\`**.

## Wiring semantics (\`generationBlock\`)
- **Outgoing image pin** ⇒ fal **still** path. **Text pin** should carry **story/lore/beats** from \`textPrimitive\` / \`textLiteral\` chains, \`sceneCompose\` **script** output, and/or **text** from upstream \`generation\` when you mean to fuse it. **Reference stills** come from \`imagePrimitive\` / \`imageLiteral\` **image** source pins.
- **Reference still** on gen **image** pin ⇒ **edit / conditioned** path (\`gpt-image-2/edit\` when applicable); **no** incoming **image** ⇒ **text-to-image**.
- **Outgoing text only** + **incoming image** ⇒ Florence **caption** (no poster render).
- **Pure text relay**: text in + text out, no image lanes ⇒ deterministic **pass-through**.

## Wiring semantics (\`videoBlock\` / \`sceneJoin\`)
- **videoBlock**: **\`image\` in required** (story still). **Default: also wire \`text\` in** from the **per-scene / beat \`textPrimitive\`**, **\`textLiteral\`**, **or** a small fusion chain so **narrative context** hits the runner’s **\`upstreamText\`** block before **\`motionPrompt\`**. Use **\`motionPrompt\`** for **how the camera moves**, **not** to replace the beat.
- **videoBlock** outgoing **video** → **\`sceneJoin.clips\`** (multiple wires allowed, **each from a video block**) **or** straight to **\`outputBlock.media\`** for a single clip preview.
- **sceneJoin**: needs **≥1** wired clip; stitched **video** out → **\`outputBlock.media\`** when exporting the assembly.

## Graph rules (enforced on write)
- **Connected DAG** (no cycles, no disconnected nodes).
- Each **generationBlock** has **≥1 outgoing** wire from **text** and/or **image** source pins matching what you intend to produce.
- Each **videoBlock** used as a clip has **≥1 incoming image** and a **video** wire into either **join** or **output**.
- When the workflow has **\`videoBlock\` nodes derived from multi-scene stories**, **each** clip node should also have **≥1 incoming \`text\` edge** (beat / scene / fused story context) unless the user explicitly wants silent-montage motion only.
- Each **sceneJoin** lists **≥1** incoming **clips** edge from **videoBlock** nodes (\`video\`→\`clips\`).
- Reuse **node ids** when editing so **uploads / run artifacts** stay aligned. For a full **pivot**, new ids are fine.

## Defaults for thin story briefs
- **Thin user prompt** is **not** an excuse to strip the hierarchy: still use **separate lore / entity / beat \`textPrimitive\`s** (or **\`textLiteral\`** for frozen lines) when the brief implies **more than one character, place, or scene**. Wire each **beat** to **both** its **still gen** and the **videoBlock** node’s **green text input** whenever video exists.
- Typical spine: **\`textPrimitive\` / \`textLiteral\`** layers → **\`generationBlock\`** stills → **\`videoBlock\`** per shot (wire **text** and **image** inputs) → **\`outputBlock\`** **or** **\`sceneJoin\`** (**\`cut\`**) → **\`outputBlock\`** (stitched).
- **\`sceneCompose\`** when the brief needs **two ref stills + script** in one downstream context; wire **script out → gen \`text\`** as needed (see **How \`generationBlock\` text is built**).

## \`generationBlock.data.imageSize\` vs downstream preview
When a still feeds an \`outputBlock\`, the server may **reconcile** \`imageSize\` from **output labels** (\`fluxPresetForOutput\`). Use clear labels (e.g. “**Vertical** storyboard frame”, “**Cinematic 16:9** establishing still”) so **9:16 vs 16:9 vs square** resolves sensibly.

## Chat reference images
Attachments are merged into **the first empty \`imagePrimitive\` / \`imageLiteral\` slots** (one image per node) after a successful write. **Never** paste huge **\`dataUrl\`** blobs into JSON; **omit** \`image\` on primitives and rely on merge, **or** reuse ids so **prior blobs restore** when omitted.

## Media in snapshots
Snapshots **strip** \`imagePrimitive.image\` **and** \`imageLiteral.image\` payloads. Omitting \`image\` on an **existing** node **id** preserves the prior upload server-side.

## Tools (only these)
- **read_workflow_canvas** — optional JSON refresh (same as snapshot).
- **write_workflow_canvas** — **full** \`workflowJson\` string.

On validation failure: fix **all** issues, then call **write_workflow_canvas** again.`;

const DEFAULT_MODEL = "gpt-5.4-mini" as const;

const REASONING_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

/** OpenAI Responses-style reasoning for supported planner models (see OPENAI_WORKFLOW_REASONING_EFFORT). */
function buildOpenAiPlannerProviderOptions(): ProviderOptions | undefined {
  const raw = process.env.OPENAI_WORKFLOW_REASONING_EFFORT?.trim().toLowerCase() ?? "";
  const disable =
    raw === "none" ||
    raw === "off" ||
    raw === "false" ||
    raw === "0" ||
    raw === "disabled";

  let effort: ReasoningEffort | undefined;
  if (disable) {
    effort = undefined;
  } else if (REASONING_EFFORT_LEVELS.includes(raw as ReasoningEffort)) {
    effort = raw as ReasoningEffort;
  } else {
    effort = "low";
  }

  if (!effort) return undefined;

  const forceRaw = process.env.OPENAI_WORKFLOW_FORCE_REASONING?.trim();
  const forceReasoning =
    forceRaw === "1" || forceRaw?.toLowerCase() === "true";

  return {
    openai: {
      reasoningEffort: effort,
      ...(forceReasoning ? { forceReasoning: true as const } : {}),
    },
  };
}

/** Human-facing log line */
function clipTelemetryLine(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function describeWriteToolOutput(output: unknown): {
  ok: boolean;
  detail: string;
  issues?: string[];
} {
  if (!output || typeof output !== "object") {
    return { ok: false, detail: "write_workflow_canvas: unexpected output" };
  }
  const o = output as Record<string, unknown>;
  if (o.success === true) {
    const nc = o.nodeCount;
    const ec = o.edgeCount;
    if (typeof nc === "number" && typeof ec === "number") {
      return { ok: true, detail: `Wrote canvas (${nc} nodes, ${ec} edges)` };
    }
    return { ok: true, detail: "Wrote canvas" };
  }
  if (o.success === false && typeof o.error === "string") {
    const rawIssues = o.issues;
    const issues =
      Array.isArray(rawIssues) && rawIssues.every((x) => typeof x === "string")
        ? (rawIssues as string[])
        : undefined;
    const detail =
      issues && issues.length
        ? `${o.error}\n${issues.map((line) => `- ${line}`).join("\n")}`
        : o.error;
    return { ok: false, detail, issues };
  }
  return { ok: false, detail: `write_workflow_canvas: ${JSON.stringify(o)}` };
}

function describeGenericToolFailure(toolName: string, output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (o.success !== false) return null;
  const err = typeof o.error === "string" ? o.error : JSON.stringify(o);
  return `${toolName}: ${err}`;
}

function lastFailedWriteFromSteps(
  steps: Array<{
    staticToolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
    toolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>,
): { error: string; issues: string[] } | null {
  for (let s = steps.length - 1; s >= 0; s -= 1) {
    const step = steps[s]!;
    const merged = [...(step.staticToolResults ?? []), ...(step.toolResults ?? [])];
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const tr = merged[i]!;
      if (tr.toolName !== "write_workflow_canvas") continue;
      const o = tr.output as Record<string, unknown> | null;
      if (!o || o.success !== false) continue;
      const error = typeof o.error === "string" ? o.error : "write_workflow_canvas failed";
      const raw = o.issues;
      const issues =
        Array.isArray(raw) && raw.every((x) => typeof x === "string") && raw.length > 0
          ? [...(raw as string[])]
          : [error];
      return { error, issues };
    }
  }
  return null;
}

function summarizeFailuresFromSteps(
  steps: Array<{
    staticToolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
    toolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>,
): string {
  const lines: string[] = [];
  for (const step of steps) {
    const merged = [...(step.staticToolResults ?? []), ...(step.toolResults ?? [])];
    for (const tr of merged) {
      if (tr.toolName === "write_workflow_canvas") {
        const d = describeWriteToolOutput(tr.output);
        if (!d.ok) lines.push(d.detail);
        continue;
      }
      const g = describeGenericToolFailure(tr.toolName, tr.output);
      if (g) lines.push(g);
    }
  }
  if (lines.length) return [...new Set(lines)].join("\n\n");
  return "";
}

export type WorkflowAgentDialogTurn = {
  role: "user" | "assistant";
  content: string;
};

/** Strip wrapper used by legacy \`/api/workflow/agent\` body \`{ prompt }\`. */
function extractCampaignBriefFromDialog(dialog: WorkflowAgentDialogTurn[]): string {
  const users = dialog.filter((t) => t.role === "user").map((t) => t.content.trim());
  const raw = users.join("\n\n").trim();
  return raw
    .replace(/^Build a workflow for this campaign request:\s*\n+/im, "")
    .replace(/^Build a photo \/ still-image workflow[^\n]*:\s*\n+/im, "")
    .trim()
    .slice(0, 6000);
}

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

const REPAIR_USER_PREFIX = "The workflow JSON did not validate";

function buildPlannerMessages(
  dialog: WorkflowAgentDialogTurn[],
  composerAttachments: MediaInputAsset[] | undefined,
): ModelMessage[] {
  const imgs =
    composerAttachments?.filter(
      (a) => typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image/"),
    ) ?? [];

  let imageAnchorIndex = -1;
  if (imgs.length > 0) {
    for (let i = dialog.length - 1; i >= 0; i--) {
      const t = dialog[i]!;
      if (t.role !== "user") continue;
      if (t.content.trimStart().startsWith(REPAIR_USER_PREFIX)) continue;
      imageAnchorIndex = i;
      break;
    }
  }

  return dialog.map((t, i) => {
    if (i === imageAnchorIndex && t.role === "user") {
      const text =
        t.content.trim() ||
        "(User attached reference image(s); treat as story/visual reference — server fills empty imagePrimitive slots after a successful write.)";
      return {
        role: "user" as const,
        content: [
          { type: "text" as const, text },
          ...imgs.map((img) => ({ type: "image" as const, image: img.dataUrl })),
        ],
      };
    }
    return { role: t.role, content: t.content };
  });
}

export function workflowAgentLegacyUserContent(prompt: string): string {
  return `Design a short-story workflow DAG with layered **\`textPrimitive\`s** (merge chains) **or \`textLiteral\`s** (verbatim copy) for lore, character sheets, place registry, per-scene beats, and optional **\`imagePrimitive\`** / **\`imageLiteral\`** (fixed upload) refs; **\`generationBlock\`** stills; **\`videoBlock\`** clips (wire each beat’s narrative text into the **videoBlock** green **text** input; use **\`motionPrompt\`** for camera/motion); **sceneCompose**/**sceneJoin** when needed; **outputBlock** preview:\n\n${prompt.trim().slice(0, 6000)}`;
}

export type WorkflowAgentGenerateResult = {
  workflow: WorkflowDocument | null;
  validationRepaired?: boolean;
  agentLog?: string[];
  /** Set when the model or planner exits without a valid workflow (for API / UI feedback). */
  validationError?: string;
  validationIssues?: string[];
};

const DEFAULT_PLANNER_ROUNDS = 4;

/** Server → client NDJSON events when `stream: true` on `/api/workflow/agent`. */
export type WorkflowAgentStreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "thinking_collapsed" }
  | { type: "round_start"; round: number }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      ok: boolean;
      summary?: string;
    }
  | { type: "log"; line: string };

export type GenerateWorkflowOptions = {
  /** Current canvas (optional). Stripped in prompt; used to restore media on write. */
  canvasSnapshot?: WorkflowDocument | null;
  /** Live reasoning / tool progress for NDJSON streaming clients. */
  streamSink?: (event: WorkflowAgentStreamEvent) => void;
  /** Images pasted or picked in the sidebar composer — merged into empty imagePrimitive / imageLiteral nodes after a successful write. */
  composerAttachments?: MediaInputAsset[];
};

export async function generateWorkflowWithOpenAI(
  dialog: WorkflowAgentDialogTurn[],
  options: GenerateWorkflowOptions = {},
): Promise<WorkflowAgentGenerateResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return { workflow: null };

  const modelId = process.env.OPENAI_WORKFLOW_MODEL?.trim() || DEFAULT_MODEL;
  const rawRounds = process.env.WORKFLOW_AGENT_MAX_PLANNER_ROUNDS?.trim();
  const parsedRounds = rawRounds ? Number.parseInt(rawRounds, 10) : NaN;
  const maxPlannerRounds = Math.max(
    1,
    Math.min(8, Number.isFinite(parsedRounds) && parsedRounds > 0 ? parsedRounds : DEFAULT_PLANNER_ROUNDS),
  );

  let workingDialog = compactDialog(dialog);
  if (workingDialog.length === 0) return { workflow: null };
  const last = workingDialog[workingDialog.length - 1]!;
  if (last.role !== "user") return { workflow: null };

  const briefForCompile = extractCampaignBriefFromDialog(workingDialog).trim() || "Campaign";
  const canvasSnapshot = options.canvasSnapshot ?? null;
  const streamSink = options.streamSink;
  const composerAttachments =
    options.composerAttachments?.filter(
      (a) => typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image/"),
    ) ?? [];

  const snapshotForPrompt = canvasSnapshot ? stripWorkflowMediaForAgent(canvasSnapshot) : null;
  const canvasBlock = snapshotForPrompt
    ? `\n\n## Canvas snapshot (media binary stripped; empty arrays here still restore prior uploads per node id on save)\n\`\`\`json\n${JSON.stringify(snapshotForPrompt, null, 2)}\n\`\`\``
    : `\n\n## Canvas snapshot\n_(empty — design a **short-story DAG**: **\`textPrimitive\`** (merge) + **\`textLiteral\`** (verbatim) lore/character/place/per-scene copy as needed; **\`imagePrimitive\`** (merge ref) + **\`imageLiteral\`** (fixed upload ref) as needed; **\`generationBlock\`** stills with **text** wired in; **\`videoBlock\`** per clip with **both** the **image** still and **text** beat wired in — **\`motionPrompt\`** carries camera/motion; use **\`sceneCompose\`** only when bundling **two** stills + **script**; wire **multiple** **videoBlock** **video** outputs to **\`sceneJoin\` \`clips\`**, join **video** → **\`outputBlock\`** with **\`cut\`** gaps; schema version ${WORKFLOW_DOCUMENT_VERSION}; fresh uuids.)_`;

  const agentLog: string[] = [];
  const pushLog = (line: string) => {
    agentLog.push(line);
    streamSink?.({ type: "log", line });
  };
  let resolvedWorkflow: WorkflowDocument | null = null;
  let totalWriteAttempts = 0;
  let outerRepairPasses = 0;
  let maxInnerStepsUsed = 0;
  let terminalValidation: { error: string; issues: string[] } | null = null;

  const openai = createOpenAI({ apiKey: key });
  const plannerProviderOptions = buildOpenAiPlannerProviderOptions();

  for (let round = 0; round < maxPlannerRounds && !resolvedWorkflow; round += 1) {
    if (round > 0) {
      streamSink?.({ type: "round_start", round });
    }
    if (round === 0) {
      pushLog("Starting canvas agent…");
    } else {
      outerRepairPasses += 1;
      pushLog(`Fix pass ${round + 1} of ${maxPlannerRounds}…`);
    }

    let innerResolved: WorkflowDocument | null = null;

    const readWorkflowCanvasTool = tool({
      description:
        "Return the current canvas WorkflowDocument as JSON (same as system snapshot; media blobs stripped). Optional.",
      inputSchema: emptyToolInputSchema,
      execute: async () => {
        const stripped = canvasSnapshot ? stripWorkflowMediaForAgent(canvasSnapshot) : null;
        return {
          success: true as const,
          empty: !canvasSnapshot,
          workflowJson: stripped ? JSON.stringify(stripped, null, 2) : "",
        };
      },
    });

    const writeWorkflowCanvasTool = tool({
      description:
        "Apply the full WorkflowDocument JSON. Default to **layered primitives** (lore, character sheets, place notes, per-scene beats, optional ref **\`imagePrimitive\`s** / **\`imageLiteral\`s**) whenever the user story names entities or multiple scenes — do **not** collapse into one mega text node unless they ask for minimal. Use **\`textLiteral\`** when copy must stay **exact** on Run (**no** upstream merge). Use **\`imageLiteral\`** when a reference still must stay **exactly** the uploaded file (**no** upstream image merge). For **\`videoBlock\`**, always wire the **scene/beat \`textPrimitive\` / \`textLiteral\` (or fused context)** into the block’s **\`text\` in** pin and reserve **\`motionPrompt\`** for **camera/motion**. Prefer **\`cut\`** in sceneJoin unless the user insists on bridges (unsupported server-side). Never rely on video→video wires.",
      inputSchema: workflowJsonInputSchema,
      execute: async ({ workflowJson }) => {
        totalWriteAttempts += 1;
        const result = validateAndFinalizeWorkflowWrite(workflowJson, {
          brief: briefForCompile,
          previousCanvas: canvasSnapshot,
        });
        if (!result.ok) {
          return {
            success: false as const,
            error: result.error,
            issues: result.issues,
          };
        }
        innerResolved = result.document;
        resolvedWorkflow = result.document;
        return {
          success: true as const,
          nodeCount: result.document.nodes.length,
          edgeCount: result.document.edges.length,
        };
      },
    });

    const streamResult = streamText({
      model: openai(modelId),
      system: SYSTEM + canvasBlock,
      messages: buildPlannerMessages(workingDialog, composerAttachments),
      tools: {
        read_workflow_canvas: readWorkflowCanvasTool,
        write_workflow_canvas: writeWorkflowCanvasTool,
      },
      prepareStep: ({ stepNumber }) => {
        if (innerResolved !== null) return {};
        if (stepNumber === 0) {
          return { toolChoice: { type: "tool", toolName: "write_workflow_canvas" } };
        }
        return {};
      },
      stopWhen: ({ steps }) => innerResolved !== null || steps.length >= 24,
      temperature: 0.42,
      ...(plannerProviderOptions ? { providerOptions: plannerProviderOptions } : {}),
      experimental_onToolCallStart: ({ toolCall }) => {
        const name = toolCall.toolName;
        if (name === "read_workflow_canvas") pushLog("Reading workflow JSON…");
        if (name === "write_workflow_canvas") pushLog("Writing workflow JSON…");
      },
      experimental_onToolCallFinish: ({ toolCall, success, output, error }) => {
        const name = toolCall.toolName;
        const toolCallId = toolCall.toolCallId;
        if (!success) {
          const msg = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
          pushLog(clipTelemetryLine(msg));
          streamSink?.({
            type: "tool_end",
            toolCallId,
            toolName: name,
            ok: false,
            summary: clipTelemetryLine(msg),
          });
          return;
        }
        if (name === "write_workflow_canvas") {
          const d = describeWriteToolOutput(output);
          pushLog(clipTelemetryLine(d.detail));
          streamSink?.({
            type: "tool_end",
            toolCallId,
            toolName: name,
            ok: d.ok,
            summary: clipTelemetryLine(d.detail),
          });
          return;
        }
        if (name === "read_workflow_canvas") {
          const o = output as Record<string, unknown>;
          const line = o.empty
            ? "Read canvas (empty)"
            : "Read canvas JSON (media stripped in tool response)";
          pushLog(line);
          streamSink?.({
            type: "tool_end",
            toolCallId,
            toolName: name,
            ok: true,
            summary: line,
          });
        }
      },
    });

    for await (const part of streamResult.fullStream) {
      if (!streamSink) continue;
      if (part.type === "reasoning-delta") {
        streamSink({ type: "reasoning_delta", text: part.text });
      } else if (part.type === "tool-input-start") {
        streamSink({ type: "thinking_collapsed" });
        streamSink({
          type: "tool_start",
          toolCallId: part.id,
          toolName: part.toolName,
        });
      } else if (part.type === "text-delta") {
        streamSink({ type: "thinking_collapsed" });
      }
    }

    const steps = await streamResult.steps;
    const modelText = await streamResult.text;
    const innerSteps = steps?.length ?? 0;
    maxInnerStepsUsed = Math.max(maxInnerStepsUsed, innerSteps);

    if (resolvedWorkflow) {
      pushLog("Workflow is ready to apply.");
      break;
    }

    const failureSummary = summarizeFailuresFromSteps(steps ?? []);
    const lastWriteErr = lastFailedWriteFromSteps(steps ?? []);
    const fallback =
      failureSummary ||
      (modelText?.trim()
        ? `Model finished without a valid write. Last assistant text:\n${modelText.trim().slice(0, 2000)}`
        : "Call write_workflow_canvas with a full valid WorkflowDocument JSON string.");

    terminalValidation =
      lastWriteErr ??
      (failureSummary
        ? { error: failureSummary, issues: [...new Set(failureSummary.split("\n\n").filter(Boolean))] }
        : { error: fallback, issues: [fallback] });

    const modelRepairText = lastWriteErr
      ? [lastWriteErr.error, "", ...lastWriteErr.issues.map((line) => `- ${line}`)].join("\n")
      : fallback;

    if (round + 1 >= maxPlannerRounds) {
      pushLog(clipTelemetryLine(`Giving up after ${maxPlannerRounds} rounds: ${terminalValidation.error}`));
      break;
    }

    pushLog("Sending validation errors back for correction…");
    workingDialog = compactDialog([
      ...workingDialog,
      {
        role: "user",
        content: [
          "The workflow JSON did not validate or the graph rules failed. Fix everything below, then call write_workflow_canvas again with the full corrected workflowJson string.",
          "",
          modelRepairText,
        ].join("\n"),
      },
    ]);
  }

  const validationRepaired =
    resolvedWorkflow !== null &&
    (outerRepairPasses > 0 || maxInnerStepsUsed > 1 || totalWriteAttempts > 1);

  if (resolvedWorkflow) {
    const workflowOut =
      composerAttachments.length > 0
        ? mergeComposerImagesIntoPrimaryImagePrimitive(resolvedWorkflow, composerAttachments)
        : resolvedWorkflow;
    return {
      workflow: workflowOut,
      validationRepaired: validationRepaired || undefined,
      agentLog,
    };
  }

  return {
    workflow: null,
    agentLog,
    validationError:
      terminalValidation?.error ??
      "The workflow agent could not produce a graph that passes validation.",
    ...(terminalValidation?.issues?.length ? { validationIssues: terminalValidation.issues } : {}),
  };
}
