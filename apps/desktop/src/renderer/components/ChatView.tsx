import { memo, useRef, useState, useSyncExternalStore } from "react";
import Markstream from "markstream-react";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "./agents/message";
import { AgentActivity, type AgentActivityItem } from "./agents/agent-activity";
import { ToolResult, ToolResultOutput } from "./agents/tool-result";
import { MessageScroller } from "./agents/message-scroller";
import type { ChatEntry, MessageItem, ToolItem } from "../store";
import { store, useStore } from "../store";
import { ApprovalStack } from "./ApprovalStack";
import { Composer } from "./Composer";

// Appendix A: each message is independently memoized; history replay disables
// smooth streaming. Streaming vs history props follow the markstream skill:
// streaming → smoothStreaming="auto" / fade=false / typewriter;
// history → smoothStreaming=false / typewriter off.
// 跟随系统主题：markstream 的 isDark 与 CSS 的 prefers-color-scheme
// 都以系统为准，单一事实来源，避免应用内再做一个独立主题状态。
function useSystemIsDark(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => true,
  );
}

const MessageView = memo(function MessageView({
  m,
  isDark,
}: {
  m: MessageItem;
  isDark: boolean;
}) {
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
            {m.thinking && <ThinkingActivity m={m} />}
            {m.text || isStreaming ? (
              <Markstream
                content={m.text}
                final={!isStreaming}
                smoothStreaming={isStreaming ? "auto" : false}
                fade={!isStreaming}
                typewriter={isStreaming}
                // markstream 官方主题开关：切换渲染器根节点 dark 类，
                // 使 --secondary/--code-bg 等 token 跟随系统明暗。
                isDark={isDark}
              />
            ) : null}
          </div>
        )}
      </MessageContent>
    </Message>
  );
});

// beUI AgentActivity（text 模式）：thinking.delta 逐行流入自动跟随的视口，
// 正文开始输出或消息结束时转为 complete 并折叠成「思考了 Ns」摘要。
// working 只在「还在流式且正文未开始」时成立，避免正文流式期间推理面板仍显示 shimmer。
function thinkingItems(thinking: string): AgentActivityItem[] {
  return thinking
    .split("\n")
    .filter(Boolean)
    .map((line, i) => ({ id: `think-${i}`, type: "text" as const, content: line }));
}

function ThinkingActivity({ m }: { m: MessageItem }) {
  const working = m.streaming && !m.text;
  // 快照 resync 会把 durationSec 抹成 undefined（数据层已回填，这里再兜
  // 一层）：记住最近一次已知耗时，摘要不回退。
  const lastDuration = useRef<number | undefined>(undefined);
  if (m.durationSec !== undefined) lastDuration.current = m.durationSec;
  const duration = m.durationSec ?? lastDuration.current;
  return (
    <AgentActivity
      className="mb-2"
      contentType="text"
      status={working ? "working" : "complete"}
      duration={duration ?? 0}
      activeLabel="正在思考…"
      maxHeight={160}
      summary={
        duration !== undefined ? (
          <>
            思考了 <span className="tabular-nums">{Math.round(duration)}s</span>
          </>
        ) : (
          "推理过程"
        )
      }
      items={thinkingItems(m.thinking ?? "")}
    />
  );
}

function ToolCard({ t }: { t: ToolItem }) {
  const running = t.status === "running";
  const status = running ? ("running" as const) : t.isError ? (("error" as const)) : ("success" as const);
  const input = collapse(t.inputPreview?.text ?? "", 60);
  const output = t.outputPreview?.text ?? "";
  const result = t.resultPreview?.text ?? "";
  return (
    <ToolResult
      tool={t.toolName}
      title={input || t.toolName}
      kind={toolKind(t)}
      status={status}
      copyText={result || output || undefined}
    >
      {output && <ToolResultOutput>{output}</ToolResultOutput>}
      {result && result !== output && <ToolResultOutput>{result}</ToolResultOutput>}
      {t.patch && <ToolResultOutput language="diff">{t.patch.text}</ToolResultOutput>}
    </ToolResult>
  );
}

// 终端类工具用 terminal 图标，其余走 custom（Wrench）。
function toolKind(t: ToolItem): "terminal" | "custom" {
  return /bash|shell|run|exec|command|terminal/i.test(t.toolName) ? "terminal" : "custom";
}

function collapse(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export function ChatView() {
  const s = useStore();
  const isDark = useSystemIsDark();
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
                <MessageView key={e.messageId} m={e} isDark={isDark} />
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
