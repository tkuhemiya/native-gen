"use client";

import {
  Fragment,
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { MediaInputAsset, WorkflowDocument } from "@/lib/workflow/schema";
import type { WorkflowAgentStreamEvent } from "@/lib/workflow/workflow-agent";

const MAX_COMPOSER_IMAGES = 8;
const MAX_IMAGE_DIMENSION = 1600;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function downscaleImageDataUrl(dataUrl: string, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (w <= maxDim && h <= maxDim) {
        resolve(dataUrl);
        return;
      }
      const scale = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = dataUrl;
  });
}

async function imageFileToComposerAsset(file: File): Promise<MediaInputAsset | null> {
  if (!file.type.startsWith("image/")) return null;
  const raw = await readFileAsDataUrl(file);
  const dataUrl = await downscaleImageDataUrl(raw, MAX_IMAGE_DIMENSION);
  return { dataUrl, fileName: file.name };
}

type AgentResponse = {
  workflow?: WorkflowDocument;
  source?: "openai" | "template";
  note?: string;
  /** Model wrap-up after tools (when the planner emits assistant text). */
  assistantMessage?: string;
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
  assistantMessage?: string;
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
  images?: MediaInputAsset[];
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

/** Stream/log lines that describe tool or validation failures — show in red when the run overall succeeds. */
function agentActivityLogLineIsErrorTone(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^failed —/i.test(t)) return true;
  if (/\bfailed:\s/i.test(t)) return true;
  if (/giving up after/i.test(t)) return true;
  if (/grapherror|did not validate|validation issues|unexpected output|workflow json did not validate/i.test(t))
    return true;
  if (/^[-•]\s/.test(t)) return true;
  if (/\n(?:[-•]\s)/.test(line)) return true;
  return false;
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
      {streamTools.map((t) => {
        const toolFailed = !t.pending && t.ok === false;
        return (
          <details
            key={t.toolCallId}
            open={t.expanded}
            className={
              toolFailed
                ? "rounded-lg border border-destructive/45 bg-destructive/[0.07] text-muted-foreground"
                : "rounded-lg border border-border bg-muted/50 text-muted-foreground"
            }
            onToggle={(e) => onToolExpandedChange(t.toolCallId, e.currentTarget.open)}
          >
            <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[10px] font-medium marker:content-none [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {t.pending ? (
                    <span className="text-muted-foreground">Running </span>
                  ) : toolFailed ? (
                    <span className="text-destructive">Failed </span>
                  ) : (
                    <span className="text-muted-foreground">Done </span>
                  )}
                  <span
                    className={`font-mono text-[10px] ${toolFailed ? "text-destructive/95" : "text-foreground/90"}`}
                  >
                    {formatToolTitle(t.toolName)}
                  </span>
                </span>
                {t.pending ? <AgentRunningDots className="shrink-0 text-primary opacity-80" /> : null}
              </span>
            </summary>
            {t.summary ? (
              <div
                className={`border-t border-border px-2.5 py-2 text-[10px] leading-snug whitespace-pre-wrap ${
                  toolFailed ? "text-destructive" : ""
                }`}
              >
                {t.summary}
              </div>
            ) : null}
          </details>
        );
      })}
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
  const [pendingComposerImages, setPendingComposerImages] = useState<MediaInputAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastAgentLog, setLastAgentLog] = useState<string[] | null>(null);
  /**
   * Full red “Agent activity” panel — only when the **request ends without applying** a workflow.
   * Not used for mid-run tool failures that the planner later corrects (those stay normal card + red text).
   *
   * Set true when: NDJSON stream has no body; stream ends with no `result` row; HTTP error response;
   * JSON body missing workflow; OpenAI path returns error without workflow / validation-only failure;
   * `fetch` throws (network / offline).
   */
  const [agentActivityFatalError, setAgentActivityFatalError] = useState(false);
  const [thinkingText, setThinkingText] = useState("");
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [streamTools, setStreamTools] = useState<StreamToolRow[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, lastAgentLog, thinkingText, streamTools, thinkingExpanded]);

  const appendComposerImages = useCallback(async (files: FileList | File[] | null | undefined) => {
    if (!files?.length) return;
    const batch: MediaInputAsset[] = [];
    for (const file of Array.from(files)) {
      const asset = await imageFileToComposerAsset(file);
      if (asset) batch.push(asset);
    }
    if (!batch.length) return;
    setPendingComposerImages((prev) => [...prev, ...batch].slice(0, MAX_COMPOSER_IMAGES));
  }, []);

  const removePendingImageAt = useCallback((index: number) => {
    setPendingComposerImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const onComposerPaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const files: File[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind !== "file") continue;
        const f = item.getAsFile();
        if (f?.type.startsWith("image/")) files.push(f);
      }
      if (!files.length) return;
      e.preventDefault();
      await appendComposerImages(files);
    },
    [appendComposerImages],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    const attachmentsToSend = [...pendingComposerImages];

    if (!text && attachmentsToSend.length === 0) {
      onStatus("Add a message or paste / attach a reference image.");
      return;
    }

    const displayContent = text || "(Image attached)";
    const userTurn: ChatTurn = {
      id: cid(),
      role: "user",
      content: displayContent,
      ...(attachmentsToSend.length ? { images: attachmentsToSend } : {}),
    };
    const priorForApi = messages.map(({ role, content }) => ({ role, content }));

    setMessages((m) => [...m, userTurn]);
    setDraft("");
    setPendingComposerImages([]);
    setBusy(true);
    setLastAgentLog([]);
    setAgentActivityFatalError(false);
    setThinkingText("");
    setThinkingExpanded(false);
    setStreamTools([]);
    onStatus("Contacting the workflow agent…");

    const apiPayload = [...priorForApi, { role: "user" as const, content: displayContent }];
    const workflow = getCanvasSnapshot();

    const finalizeSuccess = async (body: AgentResponse & { workflow: WorkflowDocument }) => {
      setAgentActivityFatalError(false);
      if (body.agentLog?.length) setLastAgentLog(body.agentLog);
      await onApplyDocument(body.workflow);
      const detailParts = [body.assistantMessage, body.note].filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      );
      const assistantContent =
        detailParts.join("\n\n") ||
        (body.source === "openai"
          ? "Updated the canvas — the graph should match your last request."
          : "Applied a starter workflow from your brief (keyword template). Add OPENAI_API_KEY for the full planner.");
      onStatus(detailParts[0] ?? (body.source === "openai" ? "Canvas updated." : assistantContent.slice(0, 120)));
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
          ...(attachmentsToSend.length ? { composerImages: attachmentsToSend } : {}),
          ...(workflow ? { workflow } : {}),
        }),
      });

      const ct = res.headers.get("content-type") ?? "";
      const isNdjson = ct.includes("ndjson");

      if (isNdjson) {
        const reader = res.body?.getReader();
        if (!reader) {
          setAgentActivityFatalError(true);
          setLastAgentLog((prev) => [...(prev ?? []), "Failed — agent stream had no body."]);
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
                if (!ev.ok) {
                  console.log("[workflow-agent] Tool call finished without success", {
                    toolName: ev.toolName,
                    toolCallId: ev.toolCallId,
                    summary: ev.summary,
                  });
                }
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
          setAgentActivityFatalError(true);
          setLastAgentLog((prev) => [...(prev ?? []), "Failed — stream ended without a result (no output)."]);
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
          setAgentActivityFatalError(true);
          setLastAgentLog((prev) => [...(prev ?? []), `Failed — ${msg}`]);
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
          setAgentActivityFatalError(true);
          setLastAgentLog((prev) => [...(prev ?? []), `Failed — ${msg}`]);
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
          assistantMessage: finalResult.assistantMessage,
          agentLog: finalResult.agentLog,
        });
        return;
      }

      const body = (await res.json()) as AgentResponse;
      if (!res.ok) {
        const msg = body.error ?? "Agent request failed";
        const issues =
          body.validationIssues?.filter(Boolean).map((line) => `• ${line}`).join("\n") ?? "";
        setAgentActivityFatalError(true);
        setLastAgentLog((prev) => [...(body.agentLog ?? prev ?? []), `Failed — ${msg}`]);
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
      if (body.agentLog?.length) {
        setLastAgentLog(body.agentLog);
        onStatus(body.agentLog[body.agentLog.length - 1] ?? null);
      }
      if (!body.workflow) {
        const msg = "Agent returned no workflow";
        const tail = body.agentLog?.length ? body.agentLog[body.agentLog.length - 1] : null;
        setAgentActivityFatalError(true);
        setLastAgentLog((prev) => [...(body.agentLog ?? prev ?? []), `Failed — ${msg}`]);
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
      setAgentActivityFatalError(true);
      setLastAgentLog((prev) => [...(prev ?? []), `Failed — ${msg}`]);
      onStatus(msg);
      setMessages((m) => [...m, { id: cid(), role: "assistant", content: msg }]);
    } finally {
      setBusy(false);
      setThinkingExpanded(false);
    }
  }, [
    draft,
    pendingComposerImages,
    getCanvasSnapshot,
    messages,
    onApplyDocument,
    onStatus,
  ]);

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
              Posts workflow agent
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Describe hooks and creatives; paste or attach reference images — they load into the Brief / posts node after send. Runs use fal still-image generation plus optional captions.
            </p>
          </div>
          <div
            className="shrink-0 text-right text-[9px] leading-tight text-muted-foreground"
            title="Wires must match pin types (text / image)"
          >
            <span className="font-semibold uppercase tracking-wide text-muted-foreground/90">
              Pins
            </span>
            <p className="mt-0.5">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />{" "}
              Text ·{" "}
              <span className="inline-block h-2 w-2 rounded-full bg-sky-500 align-middle" /> Image
            </p>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      >
        {messages.map((m, i) => {
          const isLastAssistant = m.role === "assistant" && i === messages.length - 1;
          const showCompletedTraceBefore =
            !busy &&
            isLastAssistant &&
            (thinkingText.trim().length > 0 || streamTools.length > 0);
          return (
            <Fragment key={m.id}>
              {showCompletedTraceBefore ? (
                <AgentStreamTrace
                  thinkingText={thinkingText}
                  thinkingExpanded={thinkingExpanded}
                  onThinkingExpandedChange={setThinkingExpanded}
                  streamTools={streamTools}
                  onToolExpandedChange={(toolCallId, open) =>
                    setStreamTools((prev) =>
                      prev.map((trow) =>
                        trow.toolCallId === toolCallId ? { ...trow, expanded: open } : trow,
                      ),
                    )
                  }
                />
              ) : null}
              <div
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
                  {m.images?.length ? (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {m.images.map((im, idx) => (
                        // eslint-disable-next-line @next/next/no-img-element -- chat thumbnails from data URLs
                        <img
                          key={`${im.dataUrl.slice(0, 48)}-${idx}`}
                          src={im.dataUrl}
                          alt=""
                          className="max-h-16 max-w-[5.5rem] rounded border border-primary-foreground/25 object-cover"
                        />
                      ))}
                    </div>
                  ) : null}
                  <span className="whitespace-pre-wrap">{m.content}</span>
                </div>
              </div>
            </Fragment>
          );
        })}
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
          <div
            className={
              agentActivityFatalError
                ? "mr-3 rounded-lg border border-destructive/50 bg-destructive/10 px-2.5 py-2 text-[10px] leading-snug text-destructive shadow-sm"
                : "mr-3 rounded-lg border border-border bg-background/90 px-2.5 py-2 text-[10px] leading-snug text-muted-foreground shadow-sm"
            }
            role={agentActivityFatalError ? "alert" : undefined}
          >
            <p
              className={
                agentActivityFatalError
                  ? "mb-1 font-semibold uppercase tracking-wide text-destructive"
                  : "mb-1 font-semibold uppercase tracking-wide text-foreground/80"
              }
            >
              Agent activity{agentActivityFatalError ? " · error" : ""}
            </p>
            <ul
              className={
                agentActivityFatalError
                  ? "list-inside list-disc space-y-0.5 text-destructive/95"
                  : "list-inside list-disc space-y-0.5"
              }
            >
              {lastAgentLog.map((line, i) => (
                <li
                  key={`${i}-${line.slice(0, 24)}`}
                  className={
                    agentActivityFatalError
                      ? undefined
                      : agentActivityLogLineIsErrorTone(line)
                        ? "text-destructive"
                        : undefined
                  }
                >
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border p-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          aria-hidden
          onChange={(e) => {
            void appendComposerImages(e.target.files);
            e.target.value = "";
          }}
        />
        {pendingComposerImages.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingComposerImages.map((im, idx) => (
              <span key={`${im.dataUrl.slice(0, 40)}-${idx}`} className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element -- composer preview */}
                <img
                  src={im.dataUrl}
                  alt=""
                  className="h-14 w-14 rounded-md border border-border object-cover"
                />
                <button
                  type="button"
                  disabled={busy}
                  className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border border-border bg-background text-[10px] font-bold leading-none shadow hover:bg-accent disabled:opacity-50"
                  onClick={() => removePendingImageAt(idx)}
                  aria-label="Remove attached image"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => void onComposerPaste(e)}
          onKeyDown={onComposerKeyDown}
          placeholder="Post idea, hooks, graph changes… (paste images here)"
          disabled={busy}
          rows={2}
          className="mb-2 max-h-[5.5rem] min-h-[2.75rem] w-full resize-y rounded-md border border-border bg-muted px-2 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            disabled={busy || pendingComposerImages.length >= MAX_COMPOSER_IMAGES}
            className="flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] font-medium text-card-foreground hover:bg-accent disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
          >
            Attach image
          </button>
        </div>
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
