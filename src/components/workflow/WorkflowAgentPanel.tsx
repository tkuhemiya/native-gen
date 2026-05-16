"use client";

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import type { WorkflowDocument } from "@/lib/workflow/schema";
import type { WorkflowAgentStreamEvent } from "@/lib/workflow/workflow-agent";

type AgentResponse = {
  workflow?: WorkflowDocument;
  source?: "openai" | "template";
  note?: string;
  error?: string;
  validationIssues?: string[];
  /** Ordered planner actions (tool runs, retries) for the chat UI */
  agentLog?: string[];
};

type AgentResultLine = {
  type: "result";
  workflow?: WorkflowDocument | null;
  source?: "openai" | "template";
  note?: string;
  error?: string;
  validationIssues?: string[];
  agentLog?: string[];
  validationError?: string;
  validationRepaired?: boolean;
};

type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

function cid() {
  return crypto.randomUUID();
}

function AgentRunningDots({ className }: { className?: string }) {
  return (
    <span className={["inline-flex items-end gap-0.5 pb-0.5", className].filter(Boolean).join(" ")} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 rounded-full bg-current motion-safe:animate-[bounce_1.05s_infinite]"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

function AgentRunningStatus({ announce }: { announce?: boolean }) {
  return (
    <div
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      className="flex max-w-[95%] items-center gap-2 rounded-2xl border border-border bg-muted/80 px-3 py-2.5 text-xs text-muted-foreground shadow-sm"
    >
      <AgentRunningDots className="text-primary opacity-90" />
      <span>Agent is running…</span>
    </div>
  );
}

function AgentRunningFooterBar() {
  return (
    <div
      className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-muted/70"
      aria-hidden
    >
      <AgentRunningDots className="text-primary opacity-90" />
    </div>
  );
}

type StreamToolRow = {
  toolCallId: string;
  toolName: string;
  expanded: boolean;
  pending: boolean;
  ok?: boolean;
  summary?: string;
};

function formatToolTitle(name: string) {
  return name.replace(/_/g, " ");
}

function AgentStreamTrace({
  thinkingText,
  thinkingExpanded,
  onThinkingExpandedChange,
  streamTools,
  onToolExpandedChange,
}: {
  thinkingText: string;
  thinkingExpanded: boolean;
  onThinkingExpandedChange: (open: boolean) => void;
  streamTools: StreamToolRow[];
  onToolExpandedChange: (toolCallId: string, open: boolean) => void;
}) {
  if (!thinkingText && streamTools.length === 0) return null;
  return (
    <div className="mr-3 flex flex-col gap-1.5">
      {thinkingText ? (
        <details
          open={thinkingExpanded}
          className="rounded-lg border border-border bg-muted/50 text-muted-foreground"
          onToggle={(e) => onThinkingExpandedChange(e.currentTarget.open)}
        >
          <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/80 marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="flex items-center justify-between gap-2">
              <span>Thinking</span>
            </span>
          </summary>
          <div className="max-h-40 overflow-y-auto border-t border-border px-2.5 py-2 text-[10px] leading-relaxed whitespace-pre-wrap">
            {thinkingText}
          </div>
        </details>
      ) : null}
      {streamTools.map((t) => (
        <details
          key={t.toolCallId}
          open={t.expanded}
          className="rounded-lg border border-border bg-muted/50 text-muted-foreground"
          onToggle={(e) => onToolExpandedChange(t.toolCallId, e.currentTarget.open)}
        >
          <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[10px] font-medium text-foreground/90 marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate">
                {t.pending ? (
                  <span className="text-muted-foreground">Running </span>
                ) : t.ok === false ? (
                  <span className="text-destructive">Failed </span>
                ) : (
                  <span className="text-muted-foreground">Done </span>
                )}
                <span className="font-mono text-[10px]">{formatToolTitle(t.toolName)}</span>
              </span>
              {t.pending ? <AgentRunningDots className="shrink-0 text-primary opacity-80" /> : null}
            </span>
          </summary>
          {t.summary ? (
            <div className="border-t border-border px-2.5 py-2 text-[10px] leading-snug whitespace-pre-wrap">
              {t.summary}
            </div>
          ) : null}
        </details>
      ))}
    </div>
  );
}

type WorkflowAgentPanelProps = {
  onApplyDocument: (doc: WorkflowDocument) => void | Promise<void>;
  onStatus: (message: string | null) => void;
  /** Serializes the live React Flow canvas for read/edit tool rounds (omit invalid graphs). */
  getCanvasSnapshot: () => WorkflowDocument | null;
};

export function WorkflowAgentPanel({
  onApplyDocument,
  onStatus,
  getCanvasSnapshot,
}: WorkflowAgentPanelProps) {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastAgentLog, setLastAgentLog] = useState<string[] | null>(null);
  const [thinkingText, setThinkingText] = useState("");
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [streamTools, setStreamTools] = useState<StreamToolRow[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, lastAgentLog, thinkingText, streamTools, thinkingExpanded]);

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
    setLastAgentLog([]);
    setThinkingText("");
    setThinkingExpanded(false);
    setStreamTools([]);
    onStatus("Contacting the workflow agent…");

    const apiPayload = [...priorForApi, { role: "user" as const, content: text }];
    const workflow = getCanvasSnapshot();

    const finalizeSuccess = async (body: AgentResponse & { workflow: WorkflowDocument }) => {
      if (body.agentLog?.length) setLastAgentLog(body.agentLog);
      await onApplyDocument(body.workflow);
      const hint =
        body.source === "openai"
          ? ["Applied agent workflow from the model.", body.note].filter(Boolean).join(" ")
          : body.note ?? "Applied keyword-based template workflow.";
      onStatus(hint);
      const assistantContent =
        body.source === "openai"
          ? [
              "Applied the workflow to the canvas. Ask for tweaks (e.g. add TikTok export, reorder steps).",
              body.note,
            ]
              .filter(Boolean)
              .join("\n\n")
          : ["Applied a starter workflow to the canvas from your brief.", body.note].filter(Boolean).join(
              "\n\n",
            );
      setMessages((m) => [
        ...m,
        {
          id: cid(),
          role: "assistant",
          content: assistantContent,
        },
      ]);
    };

    try {
      const res = await fetch("/api/workflow/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiPayload,
          stream: true,
          ...(workflow ? { workflow } : {}),
        }),
      });

      const ct = res.headers.get("content-type") ?? "";
      const isNdjson = ct.includes("ndjson");

      if (isNdjson) {
        const reader = res.body?.getReader();
        if (!reader) {
          onStatus("Agent stream had no body.");
          setMessages((m) => [
            ...m,
            { id: cid(), role: "assistant", content: "Could not read the agent response stream." },
          ]);
          return;
        }
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResult: AgentResultLine | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const nl = buffer.indexOf("\n");
            if (nl < 0) break;
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const row = JSON.parse(line) as Record<string, unknown>;
            if (row.type === "result") {
              finalResult = row as AgentResultLine;
              continue;
            }
            const ev = row as WorkflowAgentStreamEvent;
            switch (ev.type) {
              case "reasoning_delta":
                setThinkingText((t) => t + ev.text);
                setThinkingExpanded(true);
                break;
              case "thinking_collapsed":
                setThinkingExpanded(false);
                break;
              case "round_start":
                setThinkingText("");
                setThinkingExpanded(false);
                break;
              case "tool_start":
                setStreamTools((prev) => [
                  ...prev,
                  {
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    expanded: true,
                    pending: true,
                  },
                ]);
                break;
              case "tool_end":
                setStreamTools((prev) =>
                  prev.map((trow) =>
                    trow.toolCallId === ev.toolCallId
                      ? {
                          ...trow,
                          pending: false,
                          ok: ev.ok,
                          summary: ev.summary,
                          expanded: false,
                        }
                      : trow,
                  ),
                );
                break;
              case "log":
                setLastAgentLog((prev) => [...(prev ?? []), ev.line]);
                break;
              default:
                break;
            }
          }
        }

        if (!finalResult) {
          onStatus("Agent stream ended without a result.");
          setMessages((m) => [
            ...m,
            { id: cid(), role: "assistant", content: "The workflow agent stopped before sending a final result." },
          ]);
          return;
        }

        if (finalResult.agentLog?.length) setLastAgentLog(finalResult.agentLog);

        if (finalResult.error && !finalResult.workflow && !finalResult.validationError) {
          const msg = finalResult.error;
          const issues =
            finalResult.validationIssues?.filter(Boolean).map((line) => `• ${line}`).join("\n") ?? "";
          onStatus(msg);
          setMessages((m) => [
            ...m,
            {
              id: cid(),
              role: "assistant",
              content: issues ? `Could not update the workflow: ${msg}\n\n${issues}` : `Could not update the workflow: ${msg}`,
            },
          ]);
          return;
        }

        if (!finalResult.workflow) {
          const msg =
            finalResult.validationError ??
            finalResult.error ??
            "The model could not produce a workflow that passes validation on the server.";
          const issues =
            finalResult.validationIssues?.filter(Boolean).map((line) => `• ${line}`).join("\n") ?? "";
          onStatus(msg);
          setMessages((m) => [
            ...m,
            {
              id: cid(),
              role: "assistant",
              content: issues ? `Could not update the workflow: ${msg}\n\n${issues}` : `Could not update the workflow: ${msg}`,
            },
          ]);
          return;
        }

        if (finalResult.agentLog?.length) {
          onStatus(finalResult.agentLog[finalResult.agentLog.length - 1] ?? null);
        }

        await finalizeSuccess({
          workflow: finalResult.workflow,
          source: "openai",
          note: finalResult.note,
          agentLog: finalResult.agentLog,
        });
        return;
      }

      const body = (await res.json()) as AgentResponse;
      if (!res.ok) {
        const msg = body.error ?? "Agent request failed";
        const issues =
          body.validationIssues?.filter(Boolean).map((line) => `• ${line}`).join("\n") ?? "";
        onStatus(msg);
        setMessages((m) => [
          ...m,
          {
            id: cid(),
            role: "assistant",
            content: issues ? `Could not update the workflow: ${msg}\n\n${issues}` : `Could not update the workflow: ${msg}`,
          },
        ]);
        if (body.agentLog?.length) setLastAgentLog(body.agentLog);
        return;
      }
      if (body.agentLog?.length) {
        setLastAgentLog(body.agentLog);
        onStatus(body.agentLog[body.agentLog.length - 1] ?? null);
      }
      if (!body.workflow) {
        const msg = "Agent returned no workflow";
        const tail = body.agentLog?.length ? body.agentLog[body.agentLog.length - 1] : null;
        onStatus([msg, tail].filter(Boolean).join(" — "));
        setMessages((m) => [
          ...m,
          {
            id: cid(),
            role: "assistant",
            content: [msg, body.note].filter(Boolean).join("\n\n"),
          },
        ]);
        return;
      }
      await finalizeSuccess(body as AgentResponse & { workflow: WorkflowDocument });
    } catch {
      const msg = "Agent request failed";
      onStatus(msg);
      setMessages((m) => [...m, { id: cid(), role: "assistant", content: msg }]);
    } finally {
      setBusy(false);
    }
  }, [draft, getCanvasSnapshot, messages, onApplyDocument, onStatus]);

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) void send();
    }
  };

  return (
    <aside className="flex min-h-0 w-[min(100%,22rem)] shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Workflow agent
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Chat builds and refines your graph.
            </p>
          </div>
          <div
            className="shrink-0 text-right text-[9px] leading-tight text-muted-foreground"
            title="Wires must match pin types (text / image / video)"
          >
            <span className="font-semibold uppercase tracking-wide text-muted-foreground/90">
              Pins
            </span>
            <p className="mt-0.5">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />{" "}
              Text ·{" "}
              <span className="inline-block h-2 w-2 rounded-full bg-sky-500 align-middle" />{" "}
              Image ·{" "}
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500 align-middle" />{" "}
              Video
            </p>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      >
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
        {busy ? (
          <AgentStreamTrace
            thinkingText={thinkingText}
            thinkingExpanded={thinkingExpanded}
            onThinkingExpandedChange={setThinkingExpanded}
            streamTools={streamTools}
            onToolExpandedChange={(toolCallId, open) =>
              setStreamTools((prev) =>
                prev.map((trow) => (trow.toolCallId === toolCallId ? { ...trow, expanded: open } : trow)),
              )
            }
          />
        ) : null}
        {busy && !thinkingText && streamTools.length === 0 ? (
          <div className="mr-3 flex justify-start">
            <AgentRunningStatus announce />
          </div>
        ) : null}
        {!busy && lastAgentLog?.length ? (
          <div className="mr-3 rounded-lg border border-border bg-background/90 px-2.5 py-2 text-[10px] leading-snug text-muted-foreground shadow-sm">
            <p className="mb-1 font-semibold uppercase tracking-wide text-foreground/80">Agent activity</p>
            <ul className="list-inside list-disc space-y-0.5">
              {lastAgentLog.map((line, i) => (
                <li key={`${i}-${line.slice(0, 24)}`}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
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
        {busy ? (
          <AgentRunningFooterBar />
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Send
          </button>
        )}
      </div>
    </aside>
  );
}
