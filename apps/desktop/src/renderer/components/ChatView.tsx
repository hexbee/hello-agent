import { memo, useEffect, useRef, useState } from "react";
import Markstream from "markstream-react";
import type { ChatEntry, MessageItem, ToolItem } from "../store";
import { store, useStore } from "../store";
import { ApprovalStack } from "./ApprovalStack";
import { Composer } from "./Composer";

// Appendix A: each message is independently memoized; history replay disables
// smooth streaming. Streaming vs history props follow the markstream skill:
// streaming → smoothStreaming="auto" / fade=false / typewriter;
// history → smoothStreaming=false / typewriter off.
const MessageView = memo(function MessageView({ m }: { m: MessageItem }) {
  const isStreaming = m.streaming;
  return (
    <div className={m.role === "user" ? "flex justify-end" : ""}>
      <div
        className={
          m.role === "user"
            ? "max-w-[80%] rounded-2xl rounded-br-sm bg-accent/20 px-4 py-2.5 whitespace-pre-wrap"
            : "max-w-full"
        }
      >
        {m.role === "assistant" && (
          <div className="mb-1 text-xs font-medium text-muted">Assistant</div>
        )}
        {m.thinking && (
          <details className="mb-2 rounded-lg border border-border bg-panel-2 px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted select-none">
              推理过程
              {isStreaming && <span className="ml-2 animate-pulse">…</span>}
            </summary>
            <div className="mt-2 text-sm whitespace-pre-wrap text-muted">{m.thinking}</div>
          </details>
        )}
        {m.role === "user" ? (
          m.text
        ) : m.text || isStreaming ? (
          <Markstream
            content={m.text}
            final={!isStreaming}
            smoothStreaming={isStreaming ? "auto" : false}
            fade={!isStreaming}
            typewriter={isStreaming}
          />
        ) : null}
      </div>
    </div>
  );
});

function ToolCard({ t }: { t: ToolItem }) {
  const running = t.status === "running";
  const input = t.inputPreview?.text ?? "";
  const result = t.resultPreview?.text ?? "";
  return (
    <details className="rounded-lg border border-border bg-panel-2 text-sm" open={running}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 select-none">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            running ? "animate-pulse bg-accent" : t.isError ? "bg-danger" : "bg-ok"
          }`}
        />
        <span className="font-mono text-xs font-medium">{t.toolName}</span>
        {input && (
          <span className="truncate font-mono text-xs text-muted">{collapse(input, 120)}</span>
        )}
      </summary>
      <div className="border-t border-border px-3 py-2">
        {input && <Pre label="输入" text={input} />}
        {t.outputPreview && <Pre label="输出（进行中）" text={t.outputPreview.text} />}
        {result && <Pre label="结果" text={result} />}
        {t.patch && <Pre label="Patch" text={t.patch.text} />}
      </div>
    </details>
  );
}

function Pre({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-1 first:mt-0">
      <div className="text-[11px] text-muted">{label}</div>
      <pre className="mt-1 overflow-x-auto rounded bg-bg p-2 font-mono text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

function collapse(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export function ChatView() {
  const s = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  // Reader-aware follow: stick to the live edge until the user scrolls away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const p = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      pinnedRef.current = p;
      setPinned((prev) => (prev === p ? prev : p));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow not only on new entries, but on every delta that grows the live
  // edge (streaming text / thinking / tool output) — otherwise long streamed
  // replies grow below the viewport until the next entry forces a jump.
  const lastEntry = s.entries[s.entries.length - 1];
  const lastEntryId = lastEntry ? entryKey(lastEntry) : "";
  const liveEdgeKey = lastEntry ? liveKey(lastEntry) : "";
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEntryId, liveEdgeKey]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto px-6 py-4">
          {s.entries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
              <div className="text-base">开始新的对话</div>
              <div className="text-xs">输入消息，agent 将在工作区内协助你。</div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {s.entries.map((e) =>
                e.kind === "message" ? (
                  <MessageView key={e.messageId} m={e} />
                ) : (
                  <ToolCard key={e.toolCallId} t={e} />
                ),
              )}
            </div>
          )}
        </div>
        {!pinned && (
          <button
            type="button"
            onClick={jumpToBottom}
            title="回到底部并继续跟随"
            className="absolute bottom-3 right-8 flex h-9 items-center gap-1 rounded-full border border-border bg-panel px-3 text-sm text-fg shadow-lg transition hover:border-accent/50 hover:text-accent"
          >
            回到底部 ↓
          </button>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl px-6">
        <ApprovalStack />
        <Composer />
      </div>
    </>
  );
}

function entryKey(e: MessageItem | ToolItem): string {
  return e.kind === "message" ? e.messageId : e.toolCallId;
}

/** Signature that changes whenever the last entry's visible content grows. */
function liveKey(e: ChatEntry): string {
  if (e.kind === "message") {
    return `${e.text.length}:${e.thinking?.length ?? 0}:${e.streaming ? 1 : 0}`;
  }
  return [
    e.status,
    e.outputPreview?.text.length ?? 0,
    e.resultPreview?.text.length ?? 0,
    e.patch?.text.length ?? 0,
  ].join(":");
}

export { store };
