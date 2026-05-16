"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
import { useWorkflowRunContext } from "@/components/workflow/WorkflowRunContext";
import type { AppNode } from "@/lib/workflow/app-node";
import type { MediaInputAsset } from "@/lib/workflow/schema";

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function MediaInputNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData, getNode } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  const appendImageFile = useCallback(
    async (file: File) => {
      const dataUrl = await readFileAsDataUrl(file);
      const node = getNode(id) as AppNode | undefined;
      if (!node || node.data.kind !== "mediaInput") return;
      const next: MediaInputAsset = { dataUrl, fileName: file.name };
      updateNodeData(id, {
        ...node.data,
        images: [...node.data.images, next],
      });
    },
    [getNode, id, updateNodeData],
  );

  const appendVideoFile = useCallback(
    async (file: File) => {
      const dataUrl = await readFileAsDataUrl(file);
      const node = getNode(id) as AppNode | undefined;
      if (!node || node.data.kind !== "mediaInput") return;
      const next: MediaInputAsset = { dataUrl, fileName: file.name };
      updateNodeData(id, {
        ...node.data,
        videos: [...node.data.videos, next],
      });
    },
    [getNode, id, updateNodeData],
  );

  const removeImageAt = useCallback(
    (index: number) => {
      const node = getNode(id) as AppNode | undefined;
      if (!node || node.data.kind !== "mediaInput") return;
      updateNodeData(id, {
        ...node.data,
        images: node.data.images.filter((_, i) => i !== index),
      });
    },
    [getNode, id, updateNodeData],
  );

  const removeVideoAt = useCallback(
    (index: number) => {
      const node = getNode(id) as AppNode | undefined;
      if (!node || node.data.kind !== "mediaInput") return;
      updateNodeData(id, {
        ...node.data,
        videos: node.data.videos.filter((_, i) => i !== index),
      });
    },
    [getNode, id, updateNodeData],
  );

  const handleFileList = useCallback(
    async (files: FileList | File[] | null | undefined) => {
      if (!files?.length) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) await appendImageFile(file);
        else if (file.type.startsWith("video/")) await appendVideoFile(file);
      }
    },
    [appendImageFile, appendVideoFile],
  );

  const onPasteCapture = useCallback(
    async (e: React.ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;

      const mediaFiles: File[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (!file) continue;
        if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
          mediaFiles.push(file);
        }
      }
      if (mediaFiles.length === 0 && dt.files?.length) {
        for (const file of Array.from(dt.files)) {
          if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
            mediaFiles.push(file);
          }
        }
      }
      if (mediaFiles.length === 0) return;

      e.preventDefault();
      e.stopPropagation();
      for (const file of mediaFiles) {
        if (file.type.startsWith("image/")) await appendImageFile(file);
        else if (file.type.startsWith("video/")) await appendVideoFile(file);
      }
    },
    [appendImageFile, appendVideoFile],
  );

  if (data.kind !== "mediaInput") return null;

  const hasMedia = data.images.length > 0 || data.videos.length > 0;

  return (
    <div
      className={`relative w-[272px] rounded-lg border border-border bg-card text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
      onPasteCapture={onPasteCapture}
    >
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        style={{ top: 24 }}
        className="nodrag nopan z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-emerald-500"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "50%" }}
        className="nodrag nopan z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-sky-500"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="video"
        style={{ top: "calc(100% - 20px)" }}
        className="nodrag nopan z-10 !h-3 !w-3 !-translate-y-1/2 !border-2 !border-card !bg-amber-500"
      />
      <div className="flex cursor-grab select-none items-center justify-center rounded-t-lg border-b border-border px-2 py-1.5 active:cursor-grabbing">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Media in
        </span>
      </div>
      <p className="border-b border-border px-3 py-1 text-[9px] leading-tight text-muted-foreground">
        <span className="font-medium text-emerald-600 dark:text-emerald-400">Text</span>
        {" · "}
        <span className="font-medium text-sky-600 dark:text-sky-400">Image</span>
        {" · "}
        <span className="font-medium text-amber-600 dark:text-amber-400">Video</span>
        {" — right pins"}
      </p>
      <div className="px-3 pt-2">
        <textarea
          className="nodrag nopan nowheel h-14 w-full resize-none rounded-md border border-border bg-muted px-2 py-1 text-xs leading-snug text-foreground placeholder:text-muted-foreground outline-none focus:ring-0"
          placeholder="Type prompt or notes…"
          value={data.value}
          onChange={(e) => {
            const node = getNode(id) as AppNode | undefined;
            if (!node || node.data.kind !== "mediaInput") return;
            updateNodeData(id, { ...node.data, value: e.target.value });
          }}
        />
      </div>

      <div
        role="button"
        tabIndex={0}
        className={`nodrag nopan nowheel relative flex min-h-[112px] max-h-[200px] flex-col cursor-pointer border-t border-border px-3 py-3 transition-colors ${
          dragOver ? "bg-accent" : "bg-muted/30 hover:bg-muted/60"
        }`}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) {
            setDragOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          void handleFileList(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFileList(e.target.files);
            e.target.value = "";
          }}
        />

        {hasMedia ? (
          <div
            className="nopan nowheel mb-2 max-h-[148px] flex-1 space-y-2 overflow-y-auto pr-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            {data.images.map((asset, i) => (
              <div
                key={`img-${i}-${asset.dataUrl.slice(0, 24)}`}
                className="group relative overflow-hidden rounded-md border border-border"
              >
                <button
                  type="button"
                  className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded border border-border bg-card/95 text-xs text-card-foreground opacity-90 shadow-sm hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeImageAt(i);
                  }}
                  aria-label="Remove image"
                >
                  ×
                </button>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt=""
                  src={asset.dataUrl}
                  className="max-h-24 w-full object-cover"
                />
              </div>
            ))}
            {data.videos.map((asset, i) => (
              <div
                key={`vid-${i}-${asset.dataUrl.slice(0, 24)}`}
                className="group relative overflow-hidden rounded-md border border-border"
              >
                <button
                  type="button"
                  className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded border border-border bg-card/95 text-xs text-card-foreground opacity-90 shadow-sm hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeVideoAt(i);
                  }}
                  aria-label="Remove video"
                >
                  ×
                </button>
                <video
                  className="max-h-24 w-full object-cover"
                  src={asset.dataUrl}
                  controls
                  muted
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ))}
          </div>
        ) : null}

        {!hasMedia ? (
          <p className="select-none text-center text-[11px] leading-relaxed text-muted-foreground">
            Drop images or videos
            <br />
            <span className="text-muted-foreground/80">or paste · click to browse</span>
          </p>
        ) : (
          <p className="select-none text-center text-[10px] text-muted-foreground">
            Add more via drop, paste, or browse
          </p>
        )}
      </div>
    </div>
  );
}
