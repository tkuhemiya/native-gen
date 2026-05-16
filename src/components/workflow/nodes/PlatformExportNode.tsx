"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
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

export function PlatformExportNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const [accounts, setAccounts] = useState<PublicAccountsStatus | null>(null);

  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  const bundlePreview = useMemo(() => {
    if (runOut?.type !== "bundle") return null;
    const img = runOut.files.find(
      (f) =>
        f.blob.type.startsWith("image/") ||
        /\.(png|jpe?g|webp)$/i.test(f.path),
    );
    const vid = runOut.files.find(
      (f) => f.blob.type.startsWith("video/") || /\.mp4$/i.test(f.path),
    );
    return { img, vid };
  }, [runOut]);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bundlePreview?.img) {
      setObjectUrl(null);
      return;
    }
    const u = URL.createObjectURL(bundlePreview.img.blob);
    setObjectUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bundlePreview?.img]);

  const [videoObjectUrl, setVideoObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bundlePreview?.vid) {
      setVideoObjectUrl(null);
      return;
    }
    const u = URL.createObjectURL(bundlePreview.vid.blob);
    setVideoObjectUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bundlePreview?.vid]);

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
      className={`relative min-w-[260px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="relative mb-2 h-[52px] w-full">
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          style={{ top: 8 }}
          className="z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-emerald-500"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          style={{ top: 26 }}
          className="z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-sky-500"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="video"
          style={{ top: 44 }}
          className="z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-amber-500"
        />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Output
        </span>
      </div>
      <p className="mb-1 text-[10px] leading-snug text-muted-foreground">
        Top: copy · Middle: image(s) · Bottom: video (YouTube https)
      </p>
      {runOut?.type === "bundle" ? (
        <div className="mb-2 rounded-md border border-border bg-muted/40 p-2">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Final export
          </p>
          <div className="flex flex-wrap gap-2">
            {objectUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={objectUrl}
                alt=""
                className="h-24 max-w-[120px] rounded border border-border object-cover"
              />
            ) : null}
            {videoObjectUrl ? (
              <video
                src={videoObjectUrl}
                className="h-24 max-w-[160px] rounded border border-border object-cover"
                muted
                playsInline
                controls
              />
            ) : null}
          </div>
          {runOut.publish?.caption ? (
            <p className="mt-1 line-clamp-4 text-[9px] text-muted-foreground">
              {runOut.publish.caption}
            </p>
          ) : runOut.publishYoutube ? (
            <p className="mt-1 text-[9px] text-muted-foreground">{runOut.publishYoutube.title}</p>
          ) : null}
        </div>
      ) : null}
      <ol className="mb-2 list-decimal space-y-0.5 pl-4 text-[9px] leading-relaxed text-muted-foreground">
        <li>Connect accounts in Social accounts (reconnect Meta after scope updates).</li>
        <li>Pick platform + Page (Meta). Publish needs https images (wire from the generation image pin).</li>
        <li>Run workflow, then Publish to Meta / YouTube in the header.</li>
        <li>Demo tip: record a short screen capture as backup if Wi‑Fi fails.</li>
      </ol>
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
            After <strong className="font-medium text-foreground">Run workflow</strong>, use{" "}
            <strong className="font-medium text-foreground">Publish to Meta</strong> in the header.
            Images must be https (generation image pin). Wire multiple image edges for an Instagram carousel.
          </p>
        </div>
      ) : null}
      {data.platform === "youtube" ? (
        <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
          Wire the <strong className="font-medium text-foreground">video</strong> handle to a public https MP4,
          then use <strong className="font-medium text-foreground">Publish to YouTube</strong> in the header.
          Connect Google under Social accounts. Demo uploads respect{" "}
          <code className="rounded bg-muted px-0.5 text-[8px] text-foreground">
            NATIVE_GEN_YOUTUBE_MAX_BYTES
          </code>
          .
        </p>
      ) : null}
    </div>
  );
}
