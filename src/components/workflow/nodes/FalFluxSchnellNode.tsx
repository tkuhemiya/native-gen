"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/workflow/app-node";

export function FalFluxSchnellNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();

  if (data.kind !== "falFluxSchnell") return null;

  return (
    <div className="min-w-[260px] max-w-[320px] rounded-lg border border-black/10 bg-white px-3 py-2 shadow-sm dark:border-white/15 dark:bg-zinc-950">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          className="!h-3 !w-3 !border-2 !border-white !bg-emerald-500"
        />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          Flux Schnell
        </span>
        <Handle
          type="source"
          position={Position.Right}
          id="image"
          className="!h-3 !w-3 !border-2 !border-white !bg-sky-500"
        />
      </div>
      <label className="block text-[10px] font-medium text-zinc-500">Style suffix</label>
      <textarea
        className="nodrag nopan nowheel mt-1 h-14 w-full resize-none rounded-md border border-black/10 bg-zinc-50 px-2 py-1 text-xs text-black outline-none dark:border-white/15 dark:bg-black dark:text-zinc-50"
        value={data.suffix}
        onChange={(e) => updateNodeData(id, { ...data, suffix: e.target.value })}
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[10px] text-zinc-500">
          Aspect
          <select
            className="rounded-md border border-black/10 bg-white px-1 py-1 text-xs text-black dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-50"
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
        <label className="flex flex-col gap-1 text-[10px] text-zinc-500">
          Steps
          <input
            type="number"
            min={1}
            max={12}
            className="rounded-md border border-black/10 bg-white px-1 py-1 text-xs text-black dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-50"
            value={data.numInferenceSteps}
            onChange={(e) =>
              updateNodeData(id, {
                ...data,
                numInferenceSteps: Number(e.target.value) || 4,
              })
            }
          />
        </label>
      </div>
    </div>
  );
}
