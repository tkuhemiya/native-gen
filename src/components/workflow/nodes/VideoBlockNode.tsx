"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { useEffect } from "react";

import {
  useNodeRunOutput,
  useWorkflowRunContext,
} from "@/components/workflow/WorkflowRunContext";
import type { AppNode } from "@/lib/workflow/app-node";
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATION_SECONDS,
  VIDEO_RESOLUTIONS,
  clampVideoDurationSec,
  type VideoAspectRatio,
  type VideoResolution,
} from "@/lib/workflow/schema";
import { NodeLockButton } from "@/components/workflow/nodes/NodeLockButton";

const ASPECT_LABELS: Record<VideoAspectRatio, string> = {
  "9:16": "9:16 portrait (Reels / Shorts / TikTok)",
  "16:9": "16:9 landscape (YouTube)",
  "1:1": "1:1 square (Feed)",
};

const RESOLUTION_LABELS: Record<VideoResolution, string> = {
  "720p": "720p (default)",
  "1080p": "1080p (sharper, slower)",
};

function isAspectRatio(v: string): v is VideoAspectRatio {
  return (VIDEO_ASPECT_RATIOS as readonly string[]).includes(v);
}

function isResolution(v: string): v is VideoResolution {
  return (VIDEO_RESOLUTIONS as readonly string[]).includes(v);
}

export function VideoBlockNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "videoBlock") return null;

  const resolutionSafe: VideoResolution = (
    VIDEO_RESOLUTIONS as readonly string[]
  ).includes(data.resolution)
    ? data.resolution
    : "720p";

  useEffect(() => {
    if (resolutionSafe !== data.resolution) {
      updateNodeData(id, { ...data, resolution: resolutionSafe });
    }
  }, [data, id, resolutionSafe, updateNodeData]);

  const durationSafe = clampVideoDurationSec(data.durationSec);

  useEffect(() => {
    if (durationSafe !== data.durationSec) {
      updateNodeData(id, { ...data, durationSec: durationSafe });
    }
  }, [data, id, durationSafe, updateNodeData]);

  const videoReady = runOut?.type === "video" && !!runOut.url?.trim();

  return (
    <div
      className={`relative min-w-[260px] max-w-[320px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-violet-500 ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <NodeLockButton
        locked={data.locked}
        disabled={!videoReady}
        disabledTitle="Render once before locking"
        lockedTitle="Locked — reuse rendered clip on the next Run when satisfied"
        unlockedTitle="Unlocked — will re-render on Run"
        variant="inset"
        onToggle={(locked) => updateNodeData(id, { ...data, locked })}
      />
      <div className="relative mb-2 flex gap-3">
        <div className="flex shrink-0 flex-col justify-between gap-8 py-1">
          <Handle
            type="target"
            position={Position.Left}
            id="text"
            style={{ top: 14 }}
            title="Motion / scene text in (optional)"
            className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
          />
          <Handle
            type="target"
            position={Position.Left}
            id="image"
            style={{ bottom: 14, top: "auto" }}
            title="Source image in (required)"
            className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-start justify-between gap-2 pr-8">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                Video Block
              </span>
              <p
                className="mt-0.5 text-[9px] leading-snug text-muted-foreground"
                title="Blue pin: source still · green pin: optional motion brief."
              >
                fal Wan i2v — image in (required)
              </p>
            </div>
          </div>
          <label className="block text-[10px] font-medium text-muted-foreground">Prompt</label>
          <textarea
            className="nodrag nopan nowheel mt-1 h-14 w-full resize-none rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-foreground outline-none"
            value={data.motionPrompt}
            placeholder="Motion, camera, mood…"
            onChange={(e) => updateNodeData(id, { ...data, motionPrompt: e.target.value })}
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Aspect ratio
              <select
                className="min-w-0 max-w-full rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
                value={data.aspectRatio}
                onChange={(e) => {
                  const v = e.target.value;
                  if (isAspectRatio(v)) {
                    updateNodeData(id, { ...data, aspectRatio: v });
                  }
                }}
              >
                {VIDEO_ASPECT_RATIOS.map((ar) => (
                  <option key={ar} value={ar} title={ASPECT_LABELS[ar]}>
                    {ar}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Resolution
              <select
                className="rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
                value={resolutionSafe}
                onChange={(e) => {
                  const v = e.target.value;
                  if (isResolution(v)) {
                    updateNodeData(id, { ...data, resolution: v });
                  }
                }}
              >
                {VIDEO_RESOLUTIONS.map((r) => (
                  <option key={r} value={r} title={RESOLUTION_LABELS[r]}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-[10px] text-muted-foreground">
              Duration (fal Wan · 2–15s)
              <select
                className="rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
                value={String(durationSafe)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  updateNodeData(id, {
                    ...data,
                    durationSec: clampVideoDurationSec(n),
                  });
                }}
              >
                {VIDEO_DURATION_SECONDS.map((s) => (
                  <option key={s} value={String(s)}>
                    {s}s
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="flex shrink-0 flex-col justify-center gap-8 py-1">
          <Handle
            type="source"
            position={Position.Right}
            id="video"
            title="Video out — wire into Join scenes (clips pin) or Output preview"
            className="!right-[-6px] !h-3 !w-3 !border-2 !border-card !bg-violet-500"
          />
        </div>
      </div>

      {runningHere ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
          Rendering clip…
        </div>
      ) : null}

      {runOut?.type === "video" && runOut.url ? (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <p className="text-[9px] font-medium text-muted-foreground">Last run</p>
          <video
            className="nodrag nopan max-h-44 w-full rounded-md border border-border object-contain"
            src={runOut.url}
            controls
            playsInline
            preload="metadata"
          />
        </div>
      ) : null}
    </div>
  );
}
