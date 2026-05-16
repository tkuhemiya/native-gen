"use client";

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
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
      className="relative w-[272px] rounded-lg border border-white/10 bg-[#0a0a0a] shadow-xl"
      onPasteCapture={onPasteCapture}
    >
      <Handle
        type="source"
        position={Position.Right}
        className="z-10 !top-1/2 !h-2.5 !w-2.5 !-translate-y-1/2 !border-2 !border-[#0a0a0a] !bg-zinc-200"
      />
      <div className="flex cursor-grab select-none items-center justify-center rounded-t-lg border-b border-white/10 bg-white/[0.03] px-2 py-1.5 active:cursor-grabbing">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          Media in
        </span>
      </div>
      <div className="relative h-14 w-full">
        <textarea
          className="nodrag nopan nowheel h-full w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-snug text-zinc-100 placeholder:text-zinc-600 outline-none focus:ring-0"
          placeholder="Type prompt or notes…"
          value={data.value}
          onChange={(e) => {
            const node = getNode(id) as AppNode | undefined;
            if (!node || node.data.kind !== "mediaInput") return;
            updateNodeData(id, { ...node.data, value: e.target.value });
          }}
        />
      </div>

      <div className="border-t border-white/10" />

      <div
        role="button"
        tabIndex={0}
        className={`nodrag nopan nowheel relative flex min-h-[112px] max-h-[200px] flex-col cursor-pointer px-3 py-3 transition-colors ${
          dragOver ? "bg-white/10" : "hover:bg-white/[0.04]"
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
                className="group relative overflow-hidden rounded-md border border-white/10"
              >
                <button
                  type="button"
                  className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded bg-black/70 text-xs text-zinc-200 opacity-80 hover:opacity-100"
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
                className="group relative overflow-hidden rounded-md border border-white/10"
              >
                <button
                  type="button"
                  className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded bg-black/70 text-xs text-zinc-200 opacity-80 hover:opacity-100"
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
          <p className="select-none text-center text-[11px] leading-relaxed text-zinc-500">
            Drop images or videos
            <br />
            <span className="text-zinc-600">or paste · click to browse</span>
          </p>
        ) : (
          <p className="select-none text-center text-[10px] text-zinc-600">
            Add more via drop, paste, or browse
          </p>
        )}
      </div>
    </div>
  );
}
