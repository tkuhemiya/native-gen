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
      `Full WorkflowDocument JSON: id, name, version (${WORKFLOW_DOCUMENT_VERSION}), updatedAt, nodes[], edges[]. Follow the **story primitive hierarchy** in the system prompt: primitives **fan in** to higher layers; **everything flows downstream** to a terminal **\`outputBlock\`** (still and/or clip path) unless the user explicitly asks for a non-runnable outline. **Script + storyboard (Layer 5) must feed Layer 6** before final renders. Prefer **lower-cost** gen settings when the brief allows (see system prompt **Cost / generation discipline**). Graph checks are **structural only** (DAG, legal pins, schema). **\`textLiteral\`** = locked script; **\`imageLiteral\`** = fixed ref stills. **\`videoBlock\`**: beat on green **\`text\`**, **\`motionPrompt\`** = camera/motion.`,
    ),
});

const SYSTEM = `
You are a **workflow editor** for **short-story authoring** on a single canvas: read the JSON and apply intent with **write_workflow_canvas**. **Edges carry dependency flow downstream** — higher layers **consume** merged text and ref stills from the primitives beneath them. **Fan-in** from parallel Layer 1–3 sources into each Layer 4+ consumer; **do not** rely on a single Lore→Plot→… chain. **Stitch timeline order for \`sceneJoin\`** follows **incoming clip wires**: multiple \`videoBlock\` outputs hit the join’s **\`clips\`** pin in **stable workflow edge-list order**.

**Story primitive hierarchy — follow strictly**  
Stories are built from **layered primitives**. Higher layers are **semantically downstream**: everything abstract and everything rendered **depends on** the canon established in the layers beneath. **Lower layers are never contradicted** unless the user explicitly revises them. The runtime only checks **JSON + graph wiring**; **you** enforce the hierarchy.

**Dependency is not a serial spine** — **do not** wire Lore → Plot → Character → Place → Scene as the **only** text chain. **Correct topology:** Layers **1–3** are **parallel canonical sources** (each its own node(s)). **Layers 4+** are **consumers**: wire **fan-in** so each scene / script / board / render receives **text** from **every relevant primitive** above (Lore Bible, Plot, the Character sheets in frame, the Place registry entry, Scene Log as needed). Multiple **green \`text\`** edges into one downstream node are **expected**.

**Everything connects, everything flows downstream**  
- **Terminal sink** for a runnable story graph is always **\`outputBlock\`** (via still and/or clip chain).  
- **Layers 1–3** are **sources**: each **must** have **outgoing** \`text\` / \`image\` edges **into** Layer **4+** consumers (never “floating” primitives with no downstream use).  
- **Layers 4–5** must **continue** into Layer **6** (\`generationBlock\` / \`videoBlock\`) and then to **\`outputBlock\`** — **never** a scene or script node as a **dead leaf** with no path to preview.  
- **\`textLiteral\` scripts** wire **into** board or production **\`generationBlock\`** and/or **\`videoBlock\`** \`text\` pins.  
- **Image Ref Store** (\`imagePrimitive\` / \`imageLiteral\`) **blue \`image\`** wires feed **every** Layer‑6 \`generationBlock\` (and **\`videoBlock\`** entry stills) that must match canon. Ref conditioning = stand‑in for **fixed seed / LoRA / IP‑Adapter** (no separate seed field).

## The seven layers (map to the canvas)
1. **Layer 1 — World Lore** — **Lore Bible**: rules, history, tone, physics of the world; \`textPrimitive\`; \`locked\` when frozen. Written once; **all layers comply**.  
2. **Layer 2 — Story (Plot)** — Arc, events, conflict; **\`textPrimitive\`**; **seeded by** Layer 1 (wire **both** Lore + Plot into downstream nodes, or ensure merged context includes both).  
3. **Layer 3 — Characters + Places** — **Character sheets** + **Place registry** (\`textPrimitive\` each); **Image Ref Store** stills per character face and per place establishing shot when available. Personality, arc, **canonical visual prose** on text nodes (runner **does not** merge \`image*.prompt\` into prompts).  
4. **Layer 4 — Scenes (multiple)** — Discrete scenes: goal, conflict, emotion beat, cast, place; **Scene Log** (props, costumes, time of day). \`textPrimitive\` per scene or grouped. **Wire Layer 1–3 into each scene node** (fan-in), not as a single linear chain ending in an orphan.  
5. **Layer 5 — Script + Storyboard** — Per scene: **Script** (\`textLiteral\` or \`textPrimitive\`, **\`locked: true\`** when final) with dialogue + action; **Storyboard** as text and/or **\`generationBlock\`** stills **labeled** as storyboard. **Coherency: no Layer‑6 *production* renders until script (and board intent) exists for that scene**, unless the user explicitly says to skip. Storyboard **still** wires forward into Layer 6 when you add board frames.  
6. **Layer 6 — Rendered scene** — **\`generationBlock\`** production stills; **\`videoBlock\`** clips (**blue \`image\`** required). Use **Image Ref Store** on the **image** pin for continuity. **Per-scene prompt template** for each gen call — merged **\`promptNotes\`** must amount to: **[canonical character description] + [canonical place description] + [action this scene]**; **[\`suffix\`]** carries **[shared style token]** + negatives; **reference still** = locked visual anchor. **Only the action slot** changes scene-to-scene; **do not** re-type full bibles in every leaf.  
7. **Layer 7 — Film / Video** — **\`sceneJoin\` → \`outputBlock\`** (Edit master). Reuse **\`suffix\`** and a short **\`motionPrompt\`** vocabulary for tonal consistency across clips.

**Coherency rules — never break (label nodes accordingly)**  
- **Lore Bible** — canonical rules and tone; all layers comply.  
- **Character Sheets** — canonical visual prose on **\`textPrimitive\`** + **ref still** (\`imagePrimitive\` / \`imageLiteral\`); embedding/seed = **ref image** on gen **image** pin in this product.  
- **Place Registry** — mood, geography, props, light + establishing ref; note **palette** / **lighting** / **canonical camera** in the \`textPrimitive\` body when relevant.  
- **Scene Log** — props, costumes, time of day per scene.  
- **Script** — before Layer‑6 **production** renders; **wire scripts forward** into gens/video.  
- **Image Ref Store** — face + place anchors for **every** gen that must match canon.  
- **Edit master** — \`sceneJoin\` + \`outputBlock\`; shared grade intent via **\`suffix\`** / \`motionPrompt\`.

## Capabilities (backend)
- **fal text→image** on \`generationBlock\` (default \`openai/gpt-image-2\`; override \`FAL_TEXT_TO_IMAGE_MODEL\`).
- **Florence** when a generation block outputs **text** with an **incoming image** wire (caption / describe still — **no** new render).
- **fal image→video** on \`videoBlock\` (default \`fal-ai/wan/v2.7/image-to-video\`; override \`FAL_IMAGE_TO_VIDEO_MODEL\`). **Do not** use **video** as reference into another video block — **no video→video** conditioning.
- **Scene join assembly** (server): **\`cut\`** gaps concatenate with **ffmpeg**; **\`bridge\`** gaps are **unsupported** (Run will surface a hard cut vs abort choice — prefer \`cut\` in authored JSON unless the user insists).
- Optional **social-copy** API may still exist; the **default story path** is **full stack → \`outputBlock\`** (stills and/or clips), not multi-platform publishing.

**Cost / generation discipline** — Actively **lower fal / GPU cost** when the user does **not** demand maximum fidelity. **Do not** break the story hierarchy or coherency to save money.
- **\`generationBlock\`**: prefer **fewer** separate still passes when one hero still + ref **edit** suffices; reuse **\`suffix\`**; for **Flux Schnell** (\`FAL_TEXT_TO_IMAGE_MODEL\`), **\`numInferenceSteps\`** drives cost — default **low (e.g. 2–4)** and raise **only** when the user asks for higher quality (max 12). For **GPT Image 2** / **mini**, **steps do not apply** (ignored server-side).
- **\`videoBlock\`**: prefer **shorter \`durationSec\`**, **\`720p\`** instead of **\`1080p\`**, and **fewer clips** when motion is optional; only **\`sceneJoin\`** when multiple clips are needed.
- **Avoid** redundant gens (same beat twice); **reuse node ids** and **\`locked\`** nodes when the user iterates so runs do not re-buy unchanged frames.

**Use \`textLiteral\`** for verbatim canon/script lines that must **not** merge upstream on Run; **\`imageLiteral\`** for ref stills that must **not** inherit upstream pixels. When a node must not drift on Run, set **\`locked: true\`** (Lore Bible, script, ref stills, finished renders). Reserve a **single mega \`textPrimitive\` seed** only when the user asks for a **minimal** draft.

**Continuity**
- **Lore Bible** is source of truth; **\`suffix\`** must not fight it.  
- **Reuse node ids** when iterating.  
- **Script (Layer 5) before Layer‑6 production renders** — still, **wire** script/storyboard **into** \`generationBlock\` / \`videoBlock\` and **on to \`outputBlock\`** so nothing important dead-ends.

**How \`generationBlock\` text is built (runner)**  
Contributors on the **\`text\`** pin merge in **deterministic order** (upstream **source node id** sort): **\`textPrimitive\`** (upstream + \`prompt\` + \`value\`), **\`textLiteral\`** (\`value\` only — no upstream merge), **\`generationBlock\` text** outputs, **\`sceneCompose\` \`script\`**. Result → **\`promptNotes\`**; final still prompt = **\`promptNotes\` + \`suffix\`** (+ edit preamble if ref image wired). **\`suffix\`** = **shared style token + negatives** (e.g. no watermark), not per-scene rewrites of character/place. **Anti-pattern:** full bible in every leaf — **action-forward** text on scene nodes, bibles **upstream once**.

**How \`videoBlock\` prompts are built (runner)**  
Upstream **text** merge **then** **\`motionPrompt\`**. Beats in **text** wires; **\`motionPrompt\`** = camera/motion. **Anti-pattern:** whole scene only in **\`motionPrompt\`**.

**Rich briefs** — Include the **full DAG to \`outputBlock\`**: Lore + Plot + Characters + Places (+\`ref\` stills) **fan in** → Scenes → Script / Storyboard → **\`generationBlock\`** (and **\`videoBlock\`** when motion is in scope) → **\`sceneJoin\`** when multiple clips → **\`outputBlock\`**. Omit **\`videoBlock\`** only when the user clearly wants **stills-only**; still **must** end at **\`outputBlock\`** via still chain.

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
  - **generationBlock** — \`label\`, \`suffix\` (**shared style token** + negatives, appended to fused upstream text — keep per-scene **action** in upstream **\`promptNotes\`**), \`imageSize\`, \`numInferenceSteps\` (1–12; Flux Schnell only when model env matches), \`locked\`.
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

## Graph rules (enforced on write — wiring + schema only)
These checks are **structural** (valid JSON, DAG, pins — e.g. \`textLiteral\` must not have incoming **text** edges). They **do not** validate creative prose. **You** enforce topology: **fan-in from primitives**, **no dead-end story text**, **terminal \`outputBlock\`**.

- **Connected DAG** (no cycles, no disconnected nodes).
- Each **generationBlock** has **≥1 outgoing** wire from **text** and/or **image** source pins matching what you intend to produce.
- Each **videoBlock** used as a clip has **≥1 incoming image** and a **video** wire into either **join** or **output**.
- When the workflow has **\`videoBlock\` nodes derived from multi-scene stories**, **each** clip node should also have **≥1 incoming \`text\` edge** (beat / scene / fused story context) unless the user explicitly wants silent-montage motion only.
- Each **sceneJoin** lists **≥1** incoming **clips** edge from **videoBlock** nodes (\`video\`→\`clips\`).
- Reuse **node ids** when editing so **uploads / run artifacts** stay aligned. For a full **pivot**, new ids are fine.

## Defaults for thin story briefs
- Still use **fan-in** from Lore + Plot + entities into scene/script nodes; **never** a lone Lore→…→Place chain that dead-ends.  
- Still build a **complete path to \`outputBlock\`** (at minimum **\`generationBlock\` → \`outputBlock\`**) so the graph is **runnable**.  
- **\`sceneCompose\`** when bundling **two ref stills + script** into one downstream \`text\` context.

## \`generationBlock.data.imageSize\` vs downstream preview
When a still feeds an \`outputBlock\`, the server may **reconcile** \`imageSize\` from **output labels** (\`fluxPresetForOutput\`). Use clear labels (e.g. “**Vertical** storyboard frame”, “**Cinematic 16:9** establishing still”) so **9:16 vs 16:9 vs square** resolves sensibly.

## Chat reference images
Attachments are merged into **the first empty \`imagePrimitive\` / \`imageLiteral\` slots** (one image per node) after a successful write. **Never** paste huge **\`dataUrl\`** blobs into JSON; **omit** \`image\` on primitives and rely on merge, **or** reuse ids so **prior blobs restore** when omitted.

## Media in snapshots
Snapshots **strip** \`imagePrimitive.image\` **and** \`imageLiteral.image\` payloads. Omitting \`image\` on an **existing** node **id** preserves the prior upload server-side.

## Tools (only these)
- **read_workflow_canvas** — optional JSON refresh (same as snapshot).
- **write_workflow_canvas** — **full** \`workflowJson\` string.

On validation failure: fix **all** issues, then call **write_workflow_canvas** again.

**User-visible reply** — After **write_workflow_canvas** succeeds, always output a **short** natural-language message (1–4 sentences): concrete summary of graph changes (node types, layers, key labels), not generic boilerplate.`;

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
  return `Design a **seven-layer** short-story workflow DAG: **parallel** Lore Bible, Plot, Character sheets, Place registry (\`textPrimitive\` + Image Ref stills); **fan-in** all relevant primitives (green \`text\`, blue \`image\`) into **Scenes → Script/Storyboard → production \`generationBlock\` → \`videoBlock\` (if motion) → \`sceneJoin\` (if needed) → \`outputBlock\`**. No Lore→Plot→… spine that dead-ends. Coherency labels on nodes. Brief:\n\n${prompt.trim().slice(0, 6000)}`;
}

export type WorkflowAgentGenerateResult = {
  workflow: WorkflowDocument | null;
  validationRepaired?: boolean;
  agentLog?: string[];
  /** Natural-language wrap-up from the model (streamed turn text), when any. */
  assistantMessage?: string;
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
    : `\n\n## Canvas snapshot\n_(empty — design the **seven-layer story DAG**: parallel **Lore Bible**, **Plot**, **Character** / **Place** \`textPrimitive\`s + **Image Ref** nodes; **fan-in** those **green \`text\`** (and **blue \`image\`** for refs) into **Scenes → Script/Storyboard → \`generationBlock\`** (production + optional board stills) → **\`videoBlock\`** when motion applies (**image + text** wired) → **\`sceneJoin\`** if multiple clips → **\`outputBlock\`**. **No** dead-end story \`textPrimitive\`. Schema ${WORKFLOW_DOCUMENT_VERSION}; fresh uuids.)_`;

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

  let assistantMessageSuccess = "";

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
        "Apply the full WorkflowDocument JSON. Obey the **story primitive hierarchy**: **fan-in** from Lore/Plot/Characters/Places into scenes and script; **connect the full stack** through Layer 6 to **\`outputBlock\`** — no orphan planning text. **Prefer lower-cost generation** (fewer gens, lower Flux steps, 720p / shorter clips) when quality is not specified as premium — see system **Cost / generation discipline**. **Script/storyboard (Layer 5) feeds production \`generationBlock\` / \`videoBlock\`**. **\`textLiteral\`** for locked script; **\`imageLiteral\`** for fixed refs. **\`videoBlock\`**: narrative on **\`text\` in**, **\`motionPrompt\`** = camera/motion. **\`sceneJoin\`**: prefer **\`cut\`**. No video→video.",
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
      assistantMessageSuccess = (modelText ?? "").trim();
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
      ...(assistantMessageSuccess ? { assistantMessage: assistantMessageSuccess } : {}),
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
