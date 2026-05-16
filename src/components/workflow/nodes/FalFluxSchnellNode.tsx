"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import {
  useNodeRunOutput,
  useWorkflowRunContext,
} from "@/components/workflow/WorkflowRunContext";
import {
  FAL_FLUX_IMAGE_SIZE_DIMENSIONS,
  FAL_FLUX_IMAGE_SIZE_LABELS,
  type FalFluxPresetSize,
} from "@/lib/fal/text-to-image-config";
import type { AppNode } from "@/lib/workflow/app-node";

const ASPECT_UI_ORDER = [
  "landscape_16_9",
  "portrait_16_9",
  "square_hd",
  "square",
  "landscape_4_3",
  "portrait_4_3",
] as const satisfies readonly FalFluxPresetSize[];



function isFluxPresetSize(v: string): v is FalFluxPresetSize {
  return ASPECT_UI_ORDER.some((preset) => preset === v);
}

const STEPS_TOOLTIP =
  "How many refinement passes from noise to picture. Flux Schnell is built for low numbers (try 2–4). Turning it way up rarely helps much.";

export function FalFluxSchnellNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "falFluxSchnell") return null;

  return (
    <div
      className={`min-w-[260px] max-w-[320px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          className="!h-3 !w-3 !border-2 !border-card !bg-emerald-500"
        />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Editor
        </span>
        <Handle
          type="source"
          position={Position.Right}
          id="image"
          className="!h-3 !w-3 !border-2 !border-card !bg-sky-500"
        />
      </div>
      <label className="block text-[10px] font-medium text-muted-foreground">Style suffix</label>
      <textarea
        className="nodrag nopan nowheel mt-1 h-14 w-full resize-none rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none"
        value={data.suffix}
        onChange={(e) => updateNodeData(id, { ...data, suffix: e.target.value })}
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
          Aspect
          <select
            className="min-w-0 max-w-full rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
            title={FAL_FLUX_IMAGE_SIZE_DIMENSIONS[data.imageSize]}
            value={data.imageSize}
            onChange={(e) => {
              const v = e.target.value;
              if (isFluxPresetSize(v)) {
                updateNodeData(id, { ...data, imageSize: v });
              }
            }}
          >
            {ASPECT_UI_ORDER.map((preset) => (
              <option key={preset} value={preset}>
                {FAL_FLUX_IMAGE_SIZE_LABELS[preset]}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex flex-col gap-1 text-[10px] text-muted-foreground"
          title={STEPS_TOOLTIP}
        >
          Steps
          <input
            type="number"
            min={1}
            max={12}
            className="rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
            title={STEPS_TOOLTIP}
            value={data.numInferenceSteps}
            onChange={(e) =>
              updateNodeData(id, {
                ...data,
                numInferenceSteps: Number(e.target.value) || 2,
              })
            }
          />
        </label>
      </div>
      {runOut?.type === "image" ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 text-[9px] font-medium text-muted-foreground">Result</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={runOut.url}
            alt=""
            className="max-h-44 w-full rounded-md border border-border object-contain"
          />
        </div>
      ) : null}
    </div>
  );
}
