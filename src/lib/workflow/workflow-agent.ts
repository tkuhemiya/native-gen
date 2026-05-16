import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { streamText, tool } from "ai";
import { z } from "zod";

import {
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "./schema";
import {
  stripWorkflowMediaForAgent,
  validateAndFinalizeWorkflowWrite,
} from "./workflow-canvas-agent";

const emptyToolInputSchema = z.object({});

const workflowJsonInputSchema = z.object({
  workflowJson: z
    .string()
    .min(4)
    .describe(
      "Full WorkflowDocument JSON string: id, name, version, updatedAt, nodes[], edges[]. Must match app schema (v3).",
    ),
});

const SYSTEM = `
You are a **workflow editor**: you read the canvas as JSON and apply user intent by calling **write_workflow_canvas** with the updated document (like saving a file in an IDE). **Design like a parallel scene / dependency graph:** **many nodes** share a **short upstream bible** and **fan out** into masters and **per-scene** shots — **not** a mandatory **left-to-right** “first frame then second frame” line unless the user truly wants **one** clip.

## WorkflowDocument shape
- **Root:** \`id\` (uuid string), \`name\`, \`version\`: ${WORKFLOW_DOCUMENT_VERSION}, \`updatedAt\` (ISO-8601 string), \`nodes\`, \`edges\`
- **Node:** \`id\`, \`type\` (\`mediaInput\` | \`generationBlock\` | \`platformExport\`), \`position\` { x, y }, \`data\` (must match type)
  - **mediaInput** \`data\`: \`kind: "mediaInput"\`, \`label\`, \`value\` (brief text), \`images\`[], \`videos\`[] — use empty arrays unless you intentionally clear uploads
  - **generationBlock** \`data\`: \`kind: "generationBlock"\`, \`label\` (short UI title), \`suffix\` (**long, concrete visual brief** for Flux/Veo/WAN — never slug-only; see “Diffusion & video prompts”), \`imageSize\` (e.g. \`landscape_16_9\`), \`numInferenceSteps\` (1–12), \`videoDuration\` (\`4s\`|\`6s\`|\`8s\`), \`videoResolution\`, \`videoSilent\`, \`wanDurationSec\`, \`wanResolution\`
  - **platformExport** \`data\`: \`kind: "platformExport"\`, \`label\`, \`platform\` (\`youtube\`|\`facebook\`|\`instagram\`|\`tiktok\`), optional \`metaPageId\`
- **Edge:** \`id\`, \`source\`, \`target\` (node ids), \`sourceHandle\`, \`targetHandle\` — \`"text"\`, \`"image"\`, or \`"video"\` (nullable handles allowed per schema). **Image-to-video:** still block **\`image\` out** → motion block **\`image\` in** (\`image\`↔\`image\`); optionally also wire **\`text\`↔\`text\`** for beat/motion prose.

## Graph rules (enforced on write)
- Must be a **connected DAG** (no cycles, no disconnected nodes).
- Every **generationBlock** needs **≥1 outgoing** edge (to another generation or to platformExport) matching outputs (text/image/video pins).
- **Edits:** reuse existing **node ids** when the change is incremental and the same blocks still fit the intent — that keeps user uploads and run state tied to familiar blocks.
- **Deliverable shift:** If the latest message or the snapshot suggests the user **changed their mind** about output (e.g. prose/copy-only → motion + lookdev stills, single hero → multi-character forked pipeline, stills-only → video shots, platform or format pivot), treat **write_workflow_canvas** as permission to **replace the whole graph** — new topology and **new node ids** when the old structure fights the new goal — rather than bolting patches onto a mismatched DAG. Keep existing **mediaInput** ids (with empty \`images\`/\`videos\` unless replacing uploads) only when those inputs still belong; drop or replace lanes that no longer apply.

## Story & graph complexity (**strong default**)
- **Parallel scene graph, not a linear script:** lay out **many generationBlocks side-by-side** fed by a **compact shared bible** (\`text\` fan-out). **Do not** treat the canvas as a mandatory **left-to-right timeline**, **screenplay page order**, or **one-node-after-another** pipeline. **Breadth** (forks from a hub) is the normal shape for shorts and campaigns; a **single narrow corridor** of nodes is **wrong** for “movie / film / short / trailer / reel about …” unless the user insists on **one** clip only.
- **Thin prompts → invent, then graph:** if the user only names a **topic or setting** (e.g. *“Make a short movie about a hackathon”*, *“a trailer about …”*, *“a reel for our launch”*), you **must** **invent** a **small cast** (roles + distinct looks), **invent** **2+ places** (stage, breakout room, late-night desks, lobby…), and **invent scene beats** where **people meet places** (pitch, demo panic, team huddle, winner moment…). **Express each beat as its own** still and/or shot blocks that **pull** from those masters — **heavily prefer** this over a **single** generation block or a **linear** text→text→… chain because the brief was vague.
- **Avoid** collapsing everything into the **tiny 3-node** pattern (mediaInput → **one** generationBlock → platformExport) unless the user **explicitly** wants a single asset, one hero shot, or “simplest / fastest / minimal” output.
- For **stories, narratives, campaigns, arcs, scenes, beats, kids/families, multiple characters, \`# kids\`, each kid, multiple locations, carousels, or episodic** asks: design a **wide, readable DAG** with **many generationBlocks** — **parallel lanes** for subjects and sets, **scene / interaction** nodes that **merge** those primitives; a **short text hub** for bible/outline only, **not** a long sequential spine that pretends to be “the whole story in order.”

### Story primitives first (**how to think before you wire**)
- **Decompose before you chain:** split the brief into **stable primitives** — **people/characters** (each look), **places/environments** (each master set), important **props/world rules** — then plan the graph from those atoms, not from a single melting **text→text→text** blob.
- **Parallel masters, not prose ladders:** the default for anything visual is **one \`generationBlock\` per primitive still** (character plate, location plate, key object) as **text-to-image** forks from a compact bible/outline — **not** a staircase of **text-output** blocks “refining” the same story text.
- **Merge only when they interact:** when primitives **share a frame** (conversation, crowd, chase, reunion), add **interaction** blocks — stills or shots whose **\`suffix\` explicitly describes the joint composition** (who is where, blocking, eyelines). Do **not** use long **text-only** chains as a substitute for **showing** the meet-up in image/video nodes.
- **Anti-pattern (strong):** **three or more** \`generationBlock\`s in a row that **only output \`text\`** and only wire **text→text** is **wrong** for narrative, cinematic, campaign, or multi-subject visual work — unless the user **clearly** asked for **prose-only** output (script draft, blog, legal copy, caption deck) **with no** hero stills or motion. If you need story state, keep **≤2** text stages for bible/outline/beat notes, then **fork** into media lanes.

### Creation verbs + artifact words (don’t assume prose-only)
If the brief uses **make**, **create**, **generate**, **build**, or **produce** in the same thought as **file**, **video**, **clip**, **reel**, **film**, **footage**, **render**, **animation**, **GIF**, **thumbnail**, **carousel**, **poster**, **banner**, **visual**, **episode**, **export**, **shots**, or similar, the user often wants **media or a packaged asset**, **not** a long **text→text→…→export** graph whose only product is paragraphs. Unless they clearly ask for **written-only**, **script/doc**, **blog**, **caption-only**, or **copy-only**, bias toward **\`image\`** and/or **\`video\`** pins (outline/bible text upstream is fine).

### Video / cinematic deliverables (**default graph shape**)
When the user wants **video clips**, **film**, **short film**, **trailer**, **reels**, **cinematic motion**, **footage**, **MP4 output**, or similar:
- **Do not** default to a long **text → text → … → text** “screenplay ladder” with **only the last block** wired to **video** (or one **text-only → video** synthesis for a whole story). That hides lookdev and fights consistent locations/characters.
- **Do** use a **fork-and-merge DAG**: think **storyboard + unit shots** — **parallel** character/location masters, then **per-scene** stills/motion that **recombine** them — **not** “I must wire nodes strictly in story timeline order” and **not** a single left-to-right reading order on the canvas.
- **Layers, not a queue:** the numbered list below is **what kinds of nodes to include**, **not** a mandatory **step-by-step** build order. **Many nodes should be siblings** fed by the same \`text\` hub.
  1. **Bible / premise / show bible** — one or few blocks whose **outgoing \`text\`** **fans out** to many children (at most **1–2** compact text stages for cast+world notes — then **fork wide**, do **not** drag every scene through one linear text corridor).
  2. **Parallel lookdev stills** — **one \`generationBlock\` per hero look, location master, or key environment** wired **\`text\` → \`text\`** in and **\`image\` → (next)** out. Each block **outputs only \`image\`** (text-to-image); **rich, distinct \`suffix\`** per lane.
  3. **Motion / shots** — **per clip or per scene**, add a block that takes the matching still **\`image\` out** wired to this block **\`image\` in** (edges use pin name **sourceHandle**: image, **targetHandle**: image in JSON terms), **optionally \`text\` in** from the bible or a short beat for camera/motion, and **outputs \`video\`** (image-to-video / WAN path). **Motion prompt** goes in \`suffix\` + upstream text; keep it **short and kinetic** vs the still’s static description.
  4. **platformExport** — wire **\`video\`** (and optional **\`image\`** for thumbnail). For **several clips in one exported video**, chain **\`video\` → \`video\`** continuation blocks **before** export; do not rely on wiring many parallel \`video\` pins into one export (only one upstream clip wins at bundle time).
- **Text-to-video** (\`text\` in → \`video\` out, no \`image\` in) is fine for **simple one-off B-roll**, **single-shot promos**, or when the user explicitly asks to skip stills — **not** the default for multi-character / multi-location narratives.

### Parallel stills & variants
If the brief implies **counts**, **several people**, **per character**, **each location**, **variants**, or \`# kids\`: add **one generationBlock per subject or place** on the **text-to-image** forks; **distinct, concrete \`suffix\`** each; route each **\`image\`** into its own **\`image\`→\`video\`** shot block when video is required, then into **platformExport**. **Group or interaction beats** get their **own** blocks (do not overload a single text chain to “describe everyone together” while skipping stills).

### Text chains (when to use)
- **Sequential text → text → …** is for **copy iteration**, **pure prose beats**, or **no-visual** campaigns — **rare** as the main spine when the brief mentions **characters, sets, or motion**. For **story + media**, cap **text-only** depth at the **bible/outline** tier (see **Story primitives first**); **do not** build **text→text→text→export** pipelines as the default.

- **Concrete targets:** (**a**) For narratives **with video**, aim for **≥5 generationBlocks** (often **8–15+**: bible + parallel stills + motion nodes); (**b**) for campaigns **without** motion, aim for **≥5** (often **6–12+**). More blocks are fine if the DAG stays readable.
- Usually keep **one** \`platformExport\` at the end; merge parallel lanes into it unless the user names multiple distinct destinations.

## Diffusion & video prompts (**mandatory for every generationBlock**)
- **Lookdev (\`image\` output):** \`suffix\` describes a **static** master plate (set, wardrobe, geography, palette, extras/negatives) — prioritize **spatial and identity clarity** over motion jargon.
- **Motion (\`video\` from \`image\` input):** \`suffix\` adds **movement, beats, lens behavior, pacing** atop the upstream still description; avoid contradicting fixed geography from the still unless intentional.
- **Never** ship a **suffix** (or rely on upstream text) that is **only** an opaque codename: \`hero-kid-1\`, \`scene-A\`, \`variant_03\`, beat IDs, etc. Image/video models **cannot** infer characters from internal labels — they need **explicit visual description**.
- Blocks that output **image** or **video** must combine upstream copy with a **suffix** that reads like **production direction**: subject(s) + age range + wardrobe + expression/pose, environment/set, action, camera/lens/lighting, color grade/mood, brand/ad tone, and short **negatives** when useful (“no watermark”, “no on-screen text”, “no extra fingers”).
- **Labels** stay concise for the canvas UI; the **suffix** carries the heavy Fal-facing payload — longer suffixes are expected when campaigns need specificity.
- When the user brief is thin, **infer specifics conservatively** (plausible wardrobe colors, setting, time of day) instead of leaving shorthand slugs — stay aligned with brand-safe, non-exploitative depictions.

## Media in snapshots
The **Canvas snapshot** below strips **image/video binary data** from mediaInput nodes. If you omit or leave \`images\`/\`videos\` empty for a node id that already existed, the **server keeps** the user’s prior uploads for that id.

## Tools (only these)
- **read_workflow_canvas** — returns current JSON (same as snapshot); optional refresh.
- **write_workflow_canvas** — pass **workflowJson** (single string, entire document). **Required** to apply the graph.

Call **write_workflow_canvas** with a full valid JSON graph. On failure it returns \`success: false\`, \`error\` (summary), and **\`issues\`** (per-line problems). Fix **every** issue and call **write_workflow_canvas** again.`;

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
    effort = "medium";
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

export function workflowAgentLegacyUserContent(prompt: string): string {
  return `Build a workflow for this campaign request:\n\n${prompt.trim().slice(0, 6000)}`;
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

  const snapshotForPrompt = canvasSnapshot ? stripWorkflowMediaForAgent(canvasSnapshot) : null;
  const canvasBlock = snapshotForPrompt
    ? `\n\n## Canvas snapshot (media binary stripped; empty arrays here still restore prior uploads per node id on save)\n\`\`\`json\n${JSON.stringify(snapshotForPrompt, null, 2)}\n\`\`\``
    : `\n\n## Canvas snapshot\n_(empty — new WorkflowDocument: **parallel scene graph** for anything like a **short / movie / trailer / reel** (e.g. *hackathon*): **invent** cast + **2+ places** + **scene beats**, **fork** \`text\`→many **image** masters, then **per-scene** \`image\`→\`video\`; **do not** lay out as one skinny left-to-right line. **Primitives first**; **never** long **text→text→text** spines. **One** \`mediaInput\`, compact bible hub, parallel lanes, optional **video→video** stitch, **one** \`platformExport\`; version ${WORKFLOW_DOCUMENT_VERSION}; fresh uuids.)_`;

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
        "Apply the full WorkflowDocument JSON in workflowJson — always the **entire** document. If the user pivoted deliverable vs the current canvas (e.g. copy-only → video + lookdev, new platform), rewrite the whole graph (new topology or node ids when needed) instead of patching a mismatched DAG; keep mediaInput ids only when uploads still apply. For thin cinematic prompts, **invent** cast + places + scene beats and **graph** them **in parallel** (fork/merge), **not** a linear spine. **Story primitives first:** parallel text→image masters, interaction blocks in-frame; **strongly avoid** long text→text→text chains for narrative/visual briefs (prose-only is the exception). For motion, prefer parallel lookdev forks then image→video shot blocks (\`image\` pin ↔ \`image\` pin). Do not collapse to minimal single-generate graphs unless the user asked.",
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
      messages: workingDialog.map((t) => ({
        role: t.role,
        content: t.content,
      })),
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
    return {
      workflow: resolvedWorkflow,
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
