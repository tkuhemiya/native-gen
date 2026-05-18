# Native Gen — pitch copy (ready to paste)

Use the sections below for slides or speaker notes. Replace `[brackets]`.

---

## Title — one-line promise

**Native Gen**  
**One canvas: describe it, generate it, export it—or publish it to the platforms you already use.**

---

## Problem — tool sprawl & shipping friction

**Shipping social content still means too many tools and too much copy-paste.**

Creators and small teams bounce between **AI image/video tools**, **editors**, **caption docs**, and **each network’s uploader**. The idea is fast; the **pipeline** is slow. Outputs drift—**different crops, tones, and filenames** per channel—and when something changes, you rarely **re-run just the part that broke**. There’s no single place to **see the whole path from brief to “live.”**

---

## Solution — canvas + AI + publish in one loop

**Native Gen is a visual workflow you can talk to: the AI lays out and edits the graph; you run it to generate assets, draft social copy, and push to connected accounts—or download a clean bundle.**

Same loop for **iterate → generate → ship**: change the brief or a node, run again, move on.

---

## How it works — three steps

1. **Brief the agent** — Describe the campaign or asset in plain language (and optional reference images). The copilot **proposes or updates** a workflow on the canvas—nodes, wiring, and platform targets included.  
2. **Shape the pipeline** — **Media in**, **AI generation** (still or short video for Reels/Shorts/TikTok-style verticals), **platform export** blocks for YouTube, Meta, Instagram, TikTok, plus **social copy** where you need captions.  
3. **Run and ship** — Execute the graph, review outputs, then **publish** via OAuth where integrated **or export** files for the rest.

---

## What we built — feature summary (editable table)

| What | Why it matters |
|------|----------------|
| **Visual workflow canvas** (node graph) | You **see** inputs → generation → exports; no black-box “magic prompt only.” |
| **AI workflow agent** | Natural language **creates and edits** the live graph (structure + platform targets). |
| **AI media generation** | **Fal**-backed image (and **video block** path for short motion clips). |
| **Aspect & platform awareness** | Presets align outputs with **YouTube vs feed vs Stories/Reels/TikTok-style** sizing. |
| **Social connections** | **Google / YouTube** and **Meta** OAuth; publish from the workflow. |
| **Multi-platform export** | One run fans out to **YouTube, Facebook, Instagram, TikTok** targets—publish or download. |
| **Social copy workflow** | Server routes help produce **captions / variants** next to the media story. |

*Edit rows to match what you emphasize in judging (e.g. drop a row if you skip video in demo).*

---

## Demo script — ~90s golden path + backup note

**Live path (target ~90 seconds)**

1. **Open** Native Gen → show **canvas + agent/composer** (start from sample graph or empty—your call).  
2. **Prompt** something specific, e.g. *“Vertical promo with a strong hook and CTA; I need IG Reels plus YouTube Shorts; one hero look, concise captions.”* Let the agent **apply** the workflow.  
3. **Point** at the graph: media → generation → (**video block** if you’re showing motion) → **platform exports**.  
4. **Run** the workflow → show **fresh image/video** + **caption output** if in flow.  
5. **Publish or export**: either **hit publish** on a connected Meta/YouTube path, or **download** the bundle so judges see artifacts land.

**Backup if live OAuth or Fal flakes**

- Play a **silent screen recording** of the same golden path succeeding (offline or from a stable network run). Judges still see end-to-end value. More hygiene: **`docs/social-app-review.md`** (test users, reconnect after scope changes).

---

## Differentiation — graph + real APIs vs generic chat

**Most “AI creator” tools stop at a file in your downloads folder.** Native Gen is a **Composable pipeline**: the **graph is the product**—you inspect and tweak **nodes and edges**, not just the last assistant reply. Talk **edit** repeats on the **canvas**, not endless re-threading prompts. Integrated **generation** satisfies the creative layer; **real OAuth publishers** satisfy the boring last mile—or **explicit export** when you haven’t wired a network yet.

---

## Tech — optional; drop if time is tight

- **Next.js** (App Router), **React**, **TypeScript**  
- **React Flow (@xyflow/react)** workflow editor  
- **Vercel AI SDK** + **OpenAI** for the workflow agent  
- **Fal** for generation / video-motion routes  
- **OAuth** flows for Google (YouTube) and Meta APIs; **Zod** for API validation  

*(One verbal line alternative: “Web app today; the architecture is deliberately API-first around workflows and publishes.”)*

---

## Traction / next steps — roadmap bullets (edit freely)

**Where we are now**

- **End-to-end demo**: build/edit workflows with the agent, run generation, attach platform targets, publish or export downloads.  

**Near-term roadmap**

- Harden **[TikTok / additional publish]** paths and error surfaces for messy real-world accounts.  
- **Workflow templates** for recurring formats (drops, tutorials, teasers)—one-click from brief to graph.  
- **Collaboration**: shared canvases / versioned workflows for tiny teams—optional for post-hackathon.  

---

## Team & ask — placeholders for judges

**Team**  
- `[Name]` — `[role / focus: product, workflows, integrations…]`  
- `[Name]` — `[role]`  
- *(Add or remove rows.)*

**Ask**  
We’d love **`[specific ask: judges’ critique / intro to creators or brands / continuation past the buildathon]`** plus feedback on **`[single question: demo clarity, integrations, roadmap priority]`**.

**Thank you** — `[demo URL or deck footer]`
