"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/workflow/app-node";

const PLATFORMS = [
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
] as const;

export function PlatformExportNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();

  if (data.kind !== "platformExport") return null;

  return (
    <div className="min-w-[260px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm">
      <div className="relative mb-6 flex items-center justify-center">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Platform pack
        </span>
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          style={{ top: "35%" }}
          className="!h-3 !w-3 !border-2 !border-card !bg-emerald-500"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          style={{ top: "65%" }}
          className="!h-3 !w-3 !border-2 !border-card !bg-sky-500"
        />
      </div>
      <p className="mb-1 text-[10px] text-muted-foreground">
        Top: copy · Bottom: master image
      </p>
      <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
        Platform
        <select
          className="rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
          value={data.platform}
          onChange={(e) => {
            const platform = e.target.value as (typeof PLATFORMS)[number]["id"];
            const label = `${PLATFORMS.find((p) => p.id === platform)?.label ?? platform} export`;
            updateNodeData(id, { ...data, platform, label });
          }}
        >
          {PLATFORMS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
