import { memo, useRef, useState } from "react";
import Markstream from "markstream-react";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "./agents/message";
import { MessageScroller } from "./agents/message-scroller";
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
    <Message from={m.role === "user" ? "user" : "assistant"}>
      <MessageContent>
        {m.role === "assistant" && (
          <MessageHeader>Assistant</MessageHeader>
        )}
        {m.role === "user" ? (
          <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent-subtle px-4 py-2.5 whitespace-pre-wrap">
            {m.text}
          </div>
        ) : (
          <div className="max-w-full">
            {m.thinking && (
              <details className="mb-2 rounded-lg border border-border bg-panel-2 px-3 py-2">
                <summary className="cursor-pointer text-xs text-muted select-none">
                  推理过程
                  {isStreaming && <span className="ml-2 animate-pulse">…</span>}
                </summary>
                <div className="mt-2 text-sm whitespace-pre-wrap text-muted">{m.thinking}</div>
              </details>
            )}
            {m.text || isStreaming ? (
              <Markstream
                content={m.text}
                final={!isStreaming}
                smoothStreaming={isStreaming ? "auto" : false}
                fade={!isStreaming}
                typewriter={isStreaming}
              />
            ) : null}
          </div>
        )}
      </MessageContent>
    </Message>
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
  // beUI MessageScroller owns reader-aware follow (live-edge pinning,
  // release-on-scroll); we only mirror its state for the jump-back button.
  const [following, setFollowing] = useState(true);
  const viewportEl = useRef<HTMLElement | null>(null);

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <MessageScroller
          className="h-full"
          navigation="rail"
          busy={s.agentState === "running"}
          onFollowChange={setFollowing}
          viewportRef={(el) => {
            viewportEl.current = el;
          }}
          viewportClassName="px-6 py-4"
          contentClassName={
            s.entries.length === 0
              ? "mx-auto w-full max-w-3xl"
              : "mx-auto flex w-full max-w-3xl flex-col gap-4"
          }
        >
          {s.entries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
              <div className="text-base">开始新的对话</div>
              <div className="text-xs">输入消息，agent 将在工作区内协助你。</div>
            </div>
          ) : (
            s.entries.map((e) =>
              e.kind === "message" ? (
                <MessageView key={e.messageId} m={e} />
              ) : (
                <ToolCard key={e.toolCallId} t={e} />
              ),
            )
          )}
        </MessageScroller>
        {!following && (
          <button
            type="button"
            onClick={() => {
              const el = viewportEl.current;
              if (!el) return;
              el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              // Scroller re-detects live edge via scroll events and flips
              // `following` back through onFollowChange.
            }}
            title="回到底部并继续跟随"
            className="absolute bottom-3 right-8 z-10 flex h-9 items-center gap-1 rounded-full border border-border bg-panel px-3 text-sm text-fg shadow-lg transition hover:border-accent/50 hover:text-accent"
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

export { store };
