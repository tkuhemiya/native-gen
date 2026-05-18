"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { saveAs } from "file-saver";
import { useNodeRunOutput, useWorkflowRunContext } from "@/components/workflow/WorkflowRunContext";
import type { AppNode } from "@/lib/workflow/app-node";

function lockableTextPopulated(
  data: Extract<AppNode["data"], { kind: "textPrimitive" }>,
  runOut: ReturnType<typeof useNodeRunOutput>,
) {
  if (data.value.trim().length > 0) return true;
  return runOut?.type === "text" && !!runOut.value.trim();
}

function lockableImagePopulated(
  data: Extract<AppNode["data"], { kind: "imagePrimitive" }>,
  runOut: ReturnType<typeof useNodeRunOutput>,
) {
  if (data.image?.dataUrl?.trim()) return true;
  return runOut?.type === "image" && !!runOut.url?.trim();
}

export function TextPrimitiveNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "textPrimitive") return null;

  const populated = lockableTextPopulated(data, runOut);

  return (
    <div
      className={`min-w-[260px] max-w-[320px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        className="!left-[-6px] !top-[40%] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
      />
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Text primitive
          </div>
          <p className="text-[9px] text-muted-foreground">
            Lore, beats, dialogue — upstream text merges deterministically by node id.
          </p>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          id="text"
          className="!right-[-6px] !top-[40%] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
        />
      </div>
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Label</label>
      <input
        className="mb-2 w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.label}
        onChange={(e) => updateNodeData(id, { ...data, label: e.target.value })}
      />
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
        Purpose tag (UX only)
      </label>
      <input
        className="mb-2 w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        placeholder="lore · beat · outline…"
        value={data.purpose}
        onChange={(e) => updateNodeData(id, { ...data, purpose: e.target.value })}
      />
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
        Prompt / intent (saved on node)
      </label>
      <textarea
        className="nodrag nopan nowheel mb-2 h-12 w-full resize-none rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.prompt}
        onChange={(e) => updateNodeData(id, { ...data, prompt: e.target.value })}
      />
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Body</label>
      <textarea
        className="nodrag nopan nowheel mb-2 min-h-[72px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.value}
        onChange={(e) => updateNodeData(id, { ...data, value: e.target.value })}
      />
      <label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
        <input
          type="checkbox"
          className="h-3 w-3"
          checked={data.locked}
          disabled={!populated}
          title={!populated ? "Populate this text before locking" : undefined}
          onChange={(e) => updateNodeData(id, { ...data, locked: e.target.checked })}
        />
        Lock — skip regeneration once this block is satisfied on the next Run
      </label>
      {runOut?.type === "text" ? (
        <p className="mt-2 border-t border-border pt-2 text-[9px] text-muted-foreground">
          Last run length: {runOut.value.trim().length} chars
        </p>
      ) : null}
    </div>
  );
}

export function ImagePrimitiveNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "imagePrimitive") return null;

  const populated = lockableImagePopulated(data, runOut);
  const previewUrl = data.image?.dataUrl ?? (runOut?.type === "image" ? runOut.url : undefined);

  return (
    <div
      className={`min-w-[260px] max-w-[320px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-sky-500 ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: 14 }}
        className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ bottom: 14, top: "auto" }}
        className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
      />
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Image primitive
          </div>
          <p className="text-[9px] text-muted-foreground">
            One still per node — upload locally or inherit a generated URL from upstream.
          </p>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          id="image"
          style={{ top: "50%" }}
          className="!right-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
        />
      </div>
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Label</label>
      <input
        className="mb-2 w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.label}
        onChange={(e) => updateNodeData(id, { ...data, label: e.target.value })}
      />
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
        Prompt / intent
      </label>
      <textarea
        className="nodrag nopan nowheel mb-2 h-10 w-full resize-none rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.prompt}
        onChange={(e) => updateNodeData(id, { ...data, prompt: e.target.value })}
      />
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
        Upload still (optional)
      </label>
      <input
        type="file"
        accept="image/*"
        className="mb-2 w-full text-[10px] file:mr-2 file:rounded-md file:border file:border-border file:bg-card file:px-2 file:py-1"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            updateNodeData(id, {
              ...data,
              image: { dataUrl: String(reader.result), fileName: f.name },
            });
          };
          reader.readAsDataURL(f);
        }}
      />
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt=""
          className="mb-2 max-h-32 w-full rounded-md border border-border object-contain"
        />
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
        <input
          type="checkbox"
          className="h-3 w-3"
          checked={data.locked}
          disabled={!populated}
          title={!populated ? "Add an image (upload or upstream) before locking" : undefined}
          onChange={(e) => updateNodeData(id, { ...data, locked: e.target.checked })}
        />
        Lock — skip regeneration once this block is satisfied
      </label>
    </div>
  );
}

export function SceneComposeNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "sceneCompose") return null;

  const populated = runOut?.type === "sceneContext";
  return (
    <div
      className={`min-w-[280px] max-w-[340px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-amber-500 ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="relative mb-2 flex gap-2">
        <div className="flex shrink-0 flex-col justify-between gap-6 py-1">
          <Handle
            type="target"
            position={Position.Left}
            id="script"
            style={{ top: 12 }}
            className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
            title="Script / scene text"
          />
          <Handle
            type="target"
            position={Position.Left}
            id="imageA"
            style={{ top: "50%" }}
            className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
            title="Still A"
          />
          <Handle
            type="target"
            position={Position.Left}
            id="imageB"
            style={{ bottom: 8, top: "auto" }}
            className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
            title="Still B"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Scene composer
          </div>
          <p className="mb-2 text-[9px] text-muted-foreground">
            Bundles script + two stills for downstream prompts — wire primitives in.
          </p>
          <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Label</label>
          <input
            className="w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
            value={data.label}
            onChange={(e) => updateNodeData(id, { ...data, label: e.target.value })}
          />
          <label className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={data.locked}
              disabled={!populated}
              onChange={(e) => updateNodeData(id, { ...data, locked: e.target.checked })}
            />
            Lock bundled context once produced
          </label>
          {runOut?.type === "sceneContext" ? (
            <p className="mt-2 rounded-md bg-muted/40 p-2 text-[9px] leading-snug text-foreground">
              {runOut.script.slice(0, 220)}
              {runOut.script.length > 220 ? "…" : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col justify-between gap-6 py-1">
          <Handle
            type="source"
            position={Position.Right}
            id="script"
            style={{ top: 12 }}
            className="!right-[-6px] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
          />
          <Handle
            type="source"
            position={Position.Right}
            id="imageA"
            style={{ top: "50%" }}
            className="!right-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
          />
          <Handle
            type="source"
            position={Position.Right}
            id="imageB"
            style={{ bottom: 8, top: "auto" }}
            className="!right-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
          />
        </div>
      </div>
    </div>
  );
}

export function SceneJoinNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "sceneJoin") return null;

  const gaps = Math.max(0, data.orderedClipNodeIds.length - 1);
  const transLines =
    gaps === 0
      ? ""
      : Array.from({ length: gaps }, (_, i) => data.transitions[i]?.mode ?? "cut").join("\n");

  const commitLists = (clipText: string, transText: string) => {
    const orderedClipNodeIds = clipText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const modes = transText
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const transitions = Array.from({ length: Math.max(0, orderedClipNodeIds.length - 1) }, (_, i) => {
      const m = modes[i] ?? "cut";
      return { mode: m === "bridge" ? ("bridge" as const) : ("cut" as const) };
    });
    updateNodeData(id, { ...data, orderedClipNodeIds, transitions });
  };

  return (
    <div
      className={`min-w-[300px] max-w-[380px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-orange-500 ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Join scenes
      </div>
      <p className="mb-2 text-[9px] text-muted-foreground">
        Ordered clip node ids (one per line). Gap modes (`cut` / `bridge`) — unsupported bridges prompt
        you during Run.
      </p>
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
        Clip node ids · order == timeline
      </label>
      <textarea
        className="nodrag nopan nowheel mb-2 min-h-[96px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1 font-mono text-[10px] text-foreground outline-none"
        defaultValue={data.orderedClipNodeIds.join("\n")}
        key={data.orderedClipNodeIds.join("|")}
        onBlur={(e) => commitLists(e.target.value, transLines)}
      />
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
        Gap modes ({gaps || 0} gaps)
      </label>
      <textarea
        className="nodrag nopan nowheel mb-2 min-h-[56px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1 font-mono text-[10px] text-foreground outline-none"
        placeholder={"cut\ncut"}
        defaultValue={transLines}
        key={`${data.orderedClipNodeIds.join("|")}:${data.transitions.map((t) => t.mode).join(",")}`}
        onBlur={(e) => commitLists(data.orderedClipNodeIds.join("\n"), e.target.value)}
      />
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Label</label>
      <input
        className="w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.label}
        onChange={(e) => updateNodeData(id, { ...data, label: e.target.value })}
      />
    </div>
  );
}

export function OutputBlockNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "outputBlock") return null;

  const download = async () => {
    if (!runOut || (runOut.type !== "image" && runOut.type !== "video")) return;
    try {
      const res = await fetch(runOut.url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const ext = runOut.type === "video" ? (blob.type.includes("webm") ? "webm" : "mp4") : "png";
      saveAs(blob, `${data.label.replace(/\s+/g, "-").slice(0, 40) || "export"}.${ext}`);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={`min-w-[280px] max-w-[360px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="media"
        className="!left-[-6px] !top-1/2 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-indigo-500"
      />
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Output
      </div>
      <p className="mb-2 text-[9px] text-muted-foreground">
        Single upstream still or clip — preview locally and download.
      </p>
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Label</label>
      <input
        className="mb-2 w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.label}
        onChange={(e) => updateNodeData(id, { ...data, label: e.target.value })}
      />
      {runOut?.type === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={runOut.url}
          alt=""
          className="mb-2 max-h-56 w-full rounded-md border border-border object-contain"
        />
      ) : null}
      {runOut?.type === "video" ? (
        <video
          src={runOut.url}
          className="mb-2 max-h-56 w-full rounded-md border border-border"
          controls
        />
      ) : null}
      <button
        type="button"
        disabled={!runOut || (runOut.type !== "image" && runOut.type !== "video")}
        className="w-full rounded-md border border-border bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => void download()}
      >
        Download
      </button>
    </div>
  );
}
