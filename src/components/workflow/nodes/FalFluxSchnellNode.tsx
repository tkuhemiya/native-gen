"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/workflow/app-node";

export function FalFluxSchnellNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();

  if (data.kind !== "falFluxSchnell") return null;

  return (
    <div className="min-w-[260px] max-w-[320px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          className="!h-3 !w-3 !border-2 !border-card !bg-emerald-500"
        />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Flux Schnell
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
            className="rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
            value={data.imageSize}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "square_hd" || v === "landscape_4_3" || v === "portrait_4_3") {
                updateNodeData(id, { ...data, imageSize: v });
              }
            }}
          >
            <option value="landscape_4_3">4:3 landscape</option>
            <option value="square_hd">Square HD</option>
            <option value="portrait_4_3">4:3 portrait</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
          Steps
          <input
            type="number"
            min={1}
            max={12}
            className="rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
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
    </div>
  );
}
