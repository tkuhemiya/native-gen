"use client";

import { useCallback, useState } from "react";

import type { WorkflowDocument } from "@/lib/workflow/schema";

type AgentResponse = {
  workflow?: WorkflowDocument;
  source?: "openai" | "template";
  note?: string;
  error?: string;
};

type WorkflowAgentPanelProps = {
  onApplyDocument: (doc: WorkflowDocument) => void | Promise<void>;
  onStatus: (message: string | null) => void;
};

export function WorkflowAgentPanel({ onApplyDocument, onStatus }: WorkflowAgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const generate = useCallback(async () => {
    const text = prompt.trim();
    if (!text) {
      onStatus("Describe the campaign or creative flow first.");
      return;
    }
    setBusy(true);
    onStatus("Generating workflow…");
    try {
      const res = await fetch("/api/workflow/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const body = (await res.json()) as AgentResponse;
      if (!res.ok) {
        onStatus(body.error ?? "Agent request failed");
        return;
      }
      if (!body.workflow) {
        onStatus("Agent returned no workflow");
        return;
      }
      await onApplyDocument(body.workflow);
      const hint =
        body.source === "openai"
          ? "Applied agent workflow (model)."
          : body.note ?? "Applied template workflow.";
      onStatus(hint);
    } catch {
      onStatus("Agent request failed");
    } finally {
      setBusy(false);
    }
  }, [onApplyDocument, onStatus, prompt]);

  return (
    <aside className="flex w-[min(100%,22rem)] shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Workflow agent
        </p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          Describe the campaign; we lay out nodes and wires.           Add blocks anytime via{" "}
          <span className="font-medium text-foreground">right-click</span> on the canvas.
        </p>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Minimal skincare launch for Instagram Stories — moody studio shots, hook about ceramides, export for IG and a YouTube Shorts variant."
          disabled={busy}
          className="min-h-[140px] flex-1 resize-none rounded-md border border-border bg-muted px-2 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate workflow"}
        </button>
      </div>
    </aside>
  );
}
