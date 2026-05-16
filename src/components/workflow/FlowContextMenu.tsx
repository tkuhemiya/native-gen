"use client";

import type { RefObject } from "react";
import { createPortal } from "react-dom";
import type { CanvasNodeType } from "@/lib/workflow/schema";

export type FlowContextMenuModel =
  | { kind: "pane"; clientX: number; clientY: number }
  | { kind: "node"; clientX: number; clientY: number; nodeId: string };

type FlowContextMenuPortalProps = {
  menu: FlowContextMenuModel | null;
  menuRef: RefObject<HTMLDivElement | null>;
  onAddBlock: (type: CanvasNodeType) => void;
  onDuplicateNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
};

export function FlowContextMenuPortal({
  menu,
  menuRef,
  onAddBlock,
  onDuplicateNode,
  onDeleteNode,
}: FlowContextMenuPortalProps) {
  if (!menu) return null;

  const pad = 8;
  const estW = 220;
  const estH = menu.kind === "pane" ? 300 : 120;
  const left = Math.max(
    pad,
    Math.min(menu.clientX, window.innerWidth - estW - pad),
  );
  const top = Math.max(
    pad,
    Math.min(menu.clientY, window.innerHeight - estH - pad),
  );
  const itemCls =
    "block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900";
  const labelCls =
    "px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500";

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[200] max-h-[min(20rem,calc(100vh-2rem))] w-[13.5rem] overflow-y-auto rounded-lg border border-black/10 bg-white py-1 text-xs shadow-lg dark:border-white/15 dark:bg-zinc-950"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === "pane" ? (
        <>
          <p className={labelCls}>Input nodes</p>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onAddBlock("textInput")}
          >
            Text
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onAddBlock("imageInput")}
          >
            Image
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onAddBlock("videoInput")}
          >
            Video
          </button>
          <p className={labelCls}>Generation</p>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onAddBlock("falFluxSchnell")}
          >
            Flux Schnell (Fal)
          </button>
          <p className={labelCls}>Delivery</p>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onAddBlock("platformExport")}
          >
            Platform export
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onDuplicateNode(menu.nodeId)}
          >
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${itemCls} text-red-600 dark:text-red-400`}
            onClick={() => onDeleteNode(menu.nodeId)}
          >
            Delete
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
