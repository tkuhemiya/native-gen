"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { saveAs } from "file-saver";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  useNodeRunOutput,
  useWorkflowRunContext,
} from "@/components/workflow/WorkflowRunContext";
import type { AppNode } from "@/lib/workflow/app-node";
import type { PublicAccountsStatus } from "@/lib/oauth/public-status";

const PLATFORMS = [
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
] as const;

async function fetchAccounts(): Promise<PublicAccountsStatus> {
  const res = await fetch("/api/oauth/accounts", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load connections");
  return res.json();
}

function isBundleMediaFile(f: { path: string; blob: Blob }): boolean {
  if (f.blob.type === "application/json" || /\.json$/i.test(f.path)) {
    return false;
  }
  return f.blob.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(f.path);
}

function downloadName(path: string, index: number, blob: Blob): string {
  const base = path.split("/").pop()?.trim() || "";
  if (base) return base;
  const ext = blob.type.startsWith("image/") ? "png" : "bin";
  return `output-${index + 1}.${ext}`;
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

export function PlatformExportNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const [accounts, setAccounts] = useState<PublicAccountsStatus | null>(null);

  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  const mediaFiles = useMemo(() => {
    if (runOut?.type !== "bundle") return [];
    return runOut.files.filter(isBundleMediaFile);
  }, [runOut]);

  const noMediaUrls = useMemo<string[]>(() => [], []);
  const mediaUrls = useMemo(() => {
    if (mediaFiles.length === 0) return noMediaUrls;
    return mediaFiles.map((f) => URL.createObjectURL(f.blob));
  }, [mediaFiles, noMediaUrls]);

  useEffect(() => {
    const urls = mediaUrls;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [mediaUrls]);

  useEffect(() => {
    let cancelled = false;
    void fetchAccounts()
      .then((a) => {
        if (!cancelled) setAccounts(a);
      })
      .catch(() => {
        if (!cancelled) setAccounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (data.kind !== "platformExport") return null;

  const needsMetaPage = data.platform === "facebook" || data.platform === "instagram";
  const metaPages =
    accounts?.meta.connected === true ? accounts.meta.pages : [];
  const pageOptions =
    data.platform === "instagram"
      ? metaPages.filter((p) => p.instagramUsername != null && p.instagramUsername !== "")
      : metaPages;

  return (
    <div
      className={`relative min-w-[300px] max-w-[300px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="relative mb-2 h-[40px] w-full">
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          style={{ top: 10 }}
          className="z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-emerald-500"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          style={{ top: 30 }}
          className="z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-sky-500"
        />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Output
        </span>
      </div>

      <div className="mb-2 max-h-[260px] overflow-y-auto pr-0.5">
        {mediaFiles.length === 0 ? (
          <p className="py-6 text-center text-[10px] leading-relaxed text-muted-foreground">
            Run the workflow to show exported stills from wired inputs here.
          </p>
        ) : (
          <div className="columns-2 gap-2 [column-fill:_balance]">
            {mediaFiles.map((file, i) => {
              const src = mediaUrls[i];
              if (!src) return null;
              const name = downloadName(file.path, i, file.blob);
              return (
                <div
                  key={`${file.path}-${i}`}
                  className="relative mb-2 break-inside-avoid rounded-md border border-border bg-muted/30"
                >
                  <button
                    type="button"
                    title="Download"
                    aria-label={`Download ${name}`}
                    className="nodrag nopan absolute right-1 top-1 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background/85 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background"
                    onClick={(e) => {
                      e.stopPropagation();
                      saveAs(file.blob, name);
                    }}
                  >
                    <DownloadIcon className="h-3.5 w-3.5" />
                  </button>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt=""
                    className="max-h-48 w-full rounded-md object-cover"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {runOut?.type === "bundle" && runOut.publish?.caption ? (
        <p className="mb-2 line-clamp-3 text-[9px] text-muted-foreground">
          {runOut.publish.caption}
        </p>
      ) : null}

      <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
        Platform
        <select
          className="nodrag nopan nowheel rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
          value={data.platform}
          onChange={(e) => {
            const platform = e.target.value as (typeof PLATFORMS)[number]["id"];
            const label = `${PLATFORMS.find((p) => p.id === platform)?.label ?? platform} export`;
            const keepPage = platform === "facebook" || platform === "instagram";
            updateNodeData(id, {
              ...data,
              platform,
              label,
              metaPageId: keepPage ? data.metaPageId : undefined,
            });
          }}
        >
          {PLATFORMS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {needsMetaPage ? (
        <div className="mt-2 space-y-1">
          <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
            {data.platform === "instagram" ? "Facebook Page (linked IG)" : "Facebook Page"}
            <select
              className="nodrag nopan nowheel rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
              value={data.metaPageId ?? ""}
              onChange={(e) => {
                const metaPageId = e.target.value || undefined;
                updateNodeData(id, { ...data, metaPageId });
              }}
            >
              <option value="">
                {accounts?.meta.connected !== true
                  ? "Connect under Social accounts…"
                  : pageOptions.length === 0
                    ? data.platform === "instagram"
                      ? "No Pages with Instagram linked"
                      : "No Pages found"
                    : "Select Page…"}
              </option>
              {pageOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.instagramUsername ? ` · @${p.instagramUsername}` : ""}
                </option>
              ))}
            </select>
          </label>
          {accounts?.meta.connected !== true ? (
            <p className="text-[10px] text-muted-foreground">
              <Link href="/settings/connections" className="underline underline-offset-2">
                Open Social accounts
              </Link>{" "}
              to connect Meta.
            </p>
          ) : null}
          <p className="text-[9px] leading-relaxed text-muted-foreground">
            After <strong className="font-medium text-foreground">Run workflow</strong>, the bundle uses https images from the generation image pin. Wire multiple image edges for an Instagram carousel.
          </p>
        </div>
      ) : null}
      {data.platform === "youtube" ? (
        <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
          Wire <strong className="font-medium text-foreground">image</strong> outputs into this node — runs bundle public https stills the same way as other platforms (no separate motion pipeline).
        </p>
      ) : null}
    </div>
  );
}
