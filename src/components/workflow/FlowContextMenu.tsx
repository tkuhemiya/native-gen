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
  onStarterWorkflow: () => void;
  onExportJson: () => void;
  onTriggerImport: () => void;
};

export function FlowContextMenuPortal({
  menu,
  menuRef,
  onAddBlock,
  onDuplicateNode,
  onDeleteNode,
  onStarterWorkflow,
  onExportJson,
  onTriggerImport,
}: FlowContextMenuPortalProps) {
  if (!menu) return null;

  const pad = 8;
  const estW = 220;
  const estH = menu.kind === "pane" ? 420 : 120;
  const left = Math.max(
    pad,
    Math.min(menu.clientX, window.innerWidth - estW - pad),
  );
  const top = Math.max(
    pad,
    Math.min(menu.clientY, window.innerHeight - estH - pad),
  );
  const itemCls =
    "block w-full px-3 py-1.5 text-left text-card-foreground hover:bg-accent";
  const labelCls =
    "px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[200] max-h-[min(20rem,calc(100vh-2rem))] w-[13.5rem] overflow-y-auto rounded-lg border border-border bg-card py-1 text-xs text-card-foreground shadow-lg"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === "pane" ? (
        <>
          <p className={labelCls}>Input</p>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onAddBlock("mediaInput")}
          >
            Campaign input
          </button>
          <p className={labelCls}>Generation</p>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onAddBlock("generationBlock")}
          >
            Generation block (fal)
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
          <p className={labelCls}>Quick start</p>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onStarterWorkflow()}
          >
            Insert Text → Image starter
          </button>
          <p className={labelCls}>File</p>
          <button type="button" role="menuitem" className={itemCls} onClick={() => onExportJson()}>
            Export JSON
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => onTriggerImport()}
          >
            Import JSON
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
            className={`${itemCls} text-destructive`}
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
