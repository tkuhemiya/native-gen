"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/workflow/app-node";

export function TextInputNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();

  if (data.kind !== "textInput") return null;

  return (
    <div className="min-w-[240px] rounded-lg border border-black/10 bg-white px-3 py-2 shadow-sm dark:border-white/15 dark:bg-zinc-950">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          Text in
        </span>
        <Handle
          type="source"
          position={Position.Right}
          id="text"
          className="!h-3 !w-3 !border-2 !border-white !bg-emerald-500"
        />
      </div>
      <textarea
        className="nodrag nopan nowheel h-24 w-full resize-none rounded-md border border-black/10 bg-zinc-50 px-2 py-1 text-xs text-black outline-none focus:border-black/30 dark:border-white/15 dark:bg-black dark:text-zinc-50"
        placeholder="Campaign copy, prompt…"
        value={data.value}
        onChange={(e) =>
          updateNodeData(id, { ...data, value: e.target.value })
        }
      />
    </div>
  );
}
