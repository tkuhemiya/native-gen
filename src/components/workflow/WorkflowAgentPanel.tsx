"use client";

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import type { WorkflowDocument } from "@/lib/workflow/schema";

type AgentResponse = {
  workflow?: WorkflowDocument;
  source?: "openai" | "template";
  note?: string;
  error?: string;
};

type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

function cid() {
  return crypto.randomUUID();
}

type WorkflowAgentPanelProps = {
  onApplyDocument: (doc: WorkflowDocument) => void | Promise<void>;
  onStatus: (message: string | null) => void;
};

export function WorkflowAgentPanel({ onApplyDocument, onStatus }: WorkflowAgentPanelProps) {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) {
      onStatus("Describe the campaign or creative flow first.");
      return;
    }

    const userTurn: ChatTurn = { id: cid(), role: "user", content: text };
    const priorForApi = messages.map(({ role, content }) => ({ role, content }));

    setMessages((m) => [...m, userTurn]);
    setDraft("");
    setBusy(true);
    onStatus("Generating workflow…");

    const apiPayload = [...priorForApi, { role: "user" as const, content: text }];

    try {
      const res = await fetch("/api/workflow/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiPayload }),
      });
      const body = (await res.json()) as AgentResponse;
      if (!res.ok) {
        const msg = body.error ?? "Agent request failed";
        onStatus(msg);
        setMessages((m) => [
          ...m,
          { id: cid(), role: "assistant", content: `Could not update the workflow: ${msg}` },
        ]);
        return;
      }
      if (!body.workflow) {
        const msg = "Agent returned no workflow";
        onStatus(msg);
        setMessages((m) => [...m, { id: cid(), role: "assistant", content: msg }]);
        return;
      }
      await onApplyDocument(body.workflow);
      const hint =
        body.source === "openai"
          ? "Applied agent workflow from the model."
          : body.note ?? "Applied keyword-based template workflow.";
      onStatus(hint);
      setMessages((m) => [
        ...m,
        {
          id: cid(),
          role: "assistant",
          content:
            body.source === "openai"
              ? "Applied the workflow to the canvas. Ask for tweaks (e.g. add TikTok export, reorder steps)."
              : `${hint}`,
        },
      ]);
    } catch {
      const msg = "Agent request failed";
      onStatus(msg);
      setMessages((m) => [...m, { id: cid(), role: "assistant", content: msg }]);
    } finally {
      setBusy(false);
    }
  }, [draft, messages, onApplyDocument, onStatus]);

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) void send();
    }
  };

  return (
    <aside className="flex min-h-0 w-[min(100%,22rem)] shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Workflow agent
        </p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          Chat builds and refines your graph.
        </p>
      </div>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      >
        <div className="mr-3 rounded-lg bg-muted px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Describe your campaign or changes here. Responses update the canvas; add blocks anytime with{" "}
          <span className="font-medium text-foreground">right‑click</span> on the canvas.
        </div>
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              m.role === "user"
                ? "ml-4 flex justify-end"
                : "mr-3 flex justify-start"
            }
          >
            <div
              className={
                m.role === "user"
                  ? "max-w-[95%] rounded-lg bg-primary px-2.5 py-2 text-xs leading-relaxed text-primary-foreground"
                  : "max-w-[95%] rounded-lg bg-muted px-2.5 py-2 text-xs leading-relaxed text-foreground"
              }
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder="Campaign brief or change…"
          disabled={busy}
          rows={2}
          className="mb-2 max-h-[5.5rem] min-h-[2.75rem] w-full resize-y rounded-md border border-border bg-muted px-2 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void send()}
          className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Working…" : "Send"}
        </button>
      </div>
    </aside>
  );
}
