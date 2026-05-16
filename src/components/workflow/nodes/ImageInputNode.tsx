"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { useRef } from "react";
import type { AppNode } from "@/lib/workflow/app-node";

export function ImageInputNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const inputRef = useRef<HTMLInputElement>(null);

  if (data.kind !== "imageInput") return null;

  return (
    <div className="min-w-[240px] rounded-lg border border-black/10 bg-white px-3 py-2 shadow-sm dark:border-white/15 dark:bg-zinc-950">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          Image in
        </span>
        <Handle
          type="source"
          position={Position.Right}
          id="image"
          className="!h-3 !w-3 !border-2 !border-white !bg-sky-500"
        />
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = String(reader.result ?? "");
            updateNodeData(id, {
              ...data,
              dataUrl,
              fileName: file.name,
            });
          };
          reader.readAsDataURL(file);
        }}
      />
      <button
        type="button"
        className="w-full rounded-md border border-dashed border-black/20 bg-zinc-50 px-2 py-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-white/20 dark:bg-black dark:text-zinc-200 dark:hover:bg-zinc-900"
        onClick={() => inputRef.current?.click()}
      >
        {data.fileName ? data.fileName : "Choose image…"}
      </button>
      {data.dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          src={data.dataUrl}
          className="mt-2 max-h-28 w-full rounded-md object-cover"
        />
      ) : null}
    </div>
  );
}
