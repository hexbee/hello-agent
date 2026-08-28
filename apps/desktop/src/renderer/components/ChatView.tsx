import { memo, useRef, useState, useSyncExternalStore } from "react";
import Markstream from "markstream-react";
import { Message, MessageContent } from "./agents/message";
import { CodeBlock } from "./agents/code-block";
import { FileDiff, type FileDiffLine } from "./agents/file-diff";
import { AgentActivity, type AgentActivityItem } from "./agents/agent-activity";
import { ThinkingShimmer } from "./agents/loading-states/thinking-shimmer";
import { ToolResult, ToolResultOutput } from "./agents/tool-result";
import { MessageScroller, RAIL_LANE_PADDING } from "./agents/message-scroller";
import { cn } from "@/lib/utils";
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
        {m.role === "user" ? (
          <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent-subtle px-4 py-2.5 whitespace-pre-wrap">
            {m.text}
          </div>
        ) : (
          <div className="max-w-full">
            {m.thinking ? (
              <ThinkingActivity m={m} />
            ) : isStreaming && !m.text ? (
              // 思考内容尚未到达：先给一行与 AgentActivity working 状态同款的
              // 「正在思考…」shimmer 提示（agent-activity.md 的加载动效），
              // 首个 thinking.delta 到达后无缝切换为完整的思考流面板。
              <div
                role="status"
                className="mb-2 flex h-7 min-w-0 items-center text-sm text-muted-foreground"
              >
                <ThinkingShimmer>正在思考…</ThinkingShimmer>
              </div>
            ) : null}
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

// AgentCode 支持的语言有限，按扩展名映射；未知扩展回退 text。
function languageOf(filename: string): "bash" | "json" | "tsx" | "typescript" | "text" {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "sh" || ext === "bash" || ext === "zsh") return "bash";
  if (ext === "json") return "json";
  if (ext === "tsx" || ext === "jsx") return "tsx";
  if (ext === "ts" || ext === "js" || ext === "mjs" || ext === "cjs") return "typescript";
  return "text";
}

function basename(p: string): string {
  return p.split("/").pop() || p;
}

// 解析 unified diff 为 FileDiff 行；跳过 header/hunk 行与结果消息前缀。
function parseUnifiedDiff(text: string): FileDiffLine[] {
  const out: FileDiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const [i, raw] of text.split("\n").entries()) {
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ")
    ) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = parseInt(hunk[1]!, 10);
      newNo = parseInt(hunk[2]!, 10);
      continue;
    }
    if (raw.startsWith("\\ No newline")) continue;
    const id = `d${i}`;
    if (raw.startsWith("+")) {
      out.push({ id, type: "added", newLine: newNo++, content: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ id, type: "removed", oldLine: oldNo++, content: raw.slice(1) });
    } else {
      // 上下文行以空格开头；被截断/空行按上下文处理。
      out.push({
        id,
        type: "context",
        oldLine: oldNo++,
        newLine: newNo++,
        content: raw.startsWith(" ") ? raw.slice(1) : raw,
      });
    }
  }
  return out;
}

function ToolCard({ t }: { t: ToolItem }) {
  const running = t.status === "running";
  const args = toolArgs(t);
  const path = typeof args?.path === "string" ? args.path : undefined;

  // 编辑类（有 patch）：FileDiff 独立卡片——文件名 + 增删计数 + 折叠 + 复制。
  if (t.patch?.text && !running && !t.isError) {
    const filename = path ? basename(path) : undefined;
    return (
      <FileDiff
        file={filename ?? t.toolName}
        lines={parseUnifiedDiff(t.patch.text)}
        status="complete"
        language={filename ? languageOf(filename) : "text"}
        copyText={t.patch.text}
        maxHeight={260}
        defaultOpen={false}
      />
    );
  }

  // 写入类（input 带 content）：CodeBlock 独立卡片——文件名 + 行号 + 高亮。
  const content = typeof args?.content === "string" ? args.content : undefined;
  if (content !== undefined && path && !t.isError) {
    const filename = basename(path);
    return (
      <CodeBlock
        code={content}
        filename={filename}
        language={languageOf(filename)}
        status={running ? "streaming" : "complete"}
        maxHeight={260}
        defaultOpen={running}
      />
    );
  }

  // 其余工具：通用 ToolResult 卡片。
  const status = running ? ("running" as const) : t.isError ? (("error" as const)) : ("success" as const);
  const output = t.resultPreview?.text || t.outputPreview?.text || "";
  // 终端类工具把命令本身作为输出首行（$ ls ...），与 beUI 终端示例一致。
  const command =
    toolKind(t) === "terminal"
      ? (typeof args?.command === "string" ? (args.command as string) : undefined)
      : undefined;
  const body = [command ? `$ ${command}` : undefined, output]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const meta =
    t.durationSec !== undefined
      ? `${t.durationSec >= 10 ? Math.round(t.durationSec) : Math.round(t.durationSec * 10) / 10}s`
      : undefined;
  return (
    <ToolResult
      tool={t.toolName}
      title={toolTitle(t)}
      kind={toolKind(t)}
      status={status}
      meta={meta}
      copyText={body || undefined}
      defaultOpen={running}
    >
      {body && <ToolResultOutput>{body}</ToolResultOutput>}
      {t.patch && <ToolResultOutput language="diff">{t.patch.text}</ToolResultOutput>}
    </ToolResult>
  );
}

// inputPreview 是 allowlist 序列化后的 JSON，解析出参数对象供标题/命令行使用。
function toolArgs(t: ToolItem): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(t.inputPreview?.text ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 非 JSON（如纯文本 preview）——回退原文 */
  }
  return undefined;
}

// 工具卡标题：按优先级取主要字段（command/path/pattern…）作为人读标题，
// 取不到再回退折叠后的原文。
const TITLE_KEYS = ["command", "path", "file_path", "file", "pattern", "query", "glob", "url"];

function toolTitle(t: ToolItem): string {
  const args = toolArgs(t);
  if (args) {
    for (const k of TITLE_KEYS) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return collapse(v, 80);
    }
  }
  const raw = t.inputPreview?.text ?? "";
  return collapse(raw, 80) || t.toolName;
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
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <div className="text-base">
                {s.cwd ? "开始新的对话" : "还没有打开项目"}
              </div>
              <div className="text-xs">
                {s.cwd
                  ? "输入消息，agent 将在工作区内协助你。"
                  : "点击左侧「项目」选择一个目录开始。"}
              </div>
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

      {/* 与消息滚动区共用同一车道预留：输入区与消息列在任意溢出状态下都对齐 */}
      <div className={cn("mx-auto w-full max-w-3xl px-6", RAIL_LANE_PADDING)}>
        <ApprovalStack />
        <Composer />
      </div>
    </>
  );
}

export { store };
