import { ModelSwitchNotice } from "./ModelSwitchNotice";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import type { ThinkingLevel } from "@hello-agent/shared";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./motion/select";
import { Brain, Cpu, Shield, ShieldCheck } from "lucide-react";
import type { PromptMode, PromptModel } from "./agents/prompt-input";
import { PromptInput } from "./agents/prompt-input";
import { store, useStore } from "../store";

// beUI PromptInput: auto-grow textarea + inline model select + animated
// send/stop. IME-safe Enter submission is built into the component.
// CSP note (§3.3): provider icons are local lucide glyphs, never remote favicons.

// 会话级权限模式（弹层向上展开）：默认权限 = 只读自动放行、写操作需审批；
// 完全访问 = 所有工具自动放行。仅完全信任工作区可切换（受限工作区只有只读工具）。
const MODES: PromptMode[] = [
  {
    value: "default",
    label: "默认权限",
    description: "只读自动通过，修改文件 / 执行命令前先询问",
    icon: <Shield />,
  },
  {
    value: "full",
    label: "完全访问",
    description: "所有操作自动执行，不再询问",
    icon: <ShieldCheck />,
  },
];

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
  off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高",
};

export function Composer({ autoFocus = false }: { autoFocus?: boolean }) {
  const s = useStore();

  const models: PromptModel[] = s.models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.id}`,
    icon: <Cpu />,
    group: m.provider || undefined,
  }));

  const running = s.agentState === "running";
  // 受限工作区没有写权限可放行，「完全访问」无意义 → 不展示模式按钮。
  const showModes = s.trust === "trusted";

  return (
    <div className="py-3">
      <ModelSwitchNotice />
      <PromptInput
        placeholder={
          running
            ? "正在处理…"
            : s.entries.length === 0
              ? "你想做什么？"
              : "输入消息（Enter 发送，Shift+Enter 换行）"
        }
        aria-label="Prompt"
        autoFocus={autoFocus}
        disabled={s.trust === "untrusted"}
        loading={running}
        onStop={() => void store.abort()}
        leadingAction={<ContextUsageIndicator usage={s.contextUsage ?? null} />}
        models={models}
        modelHint={s.entries.length > 0 || running ? (
          <>
            {running ? "本轮继续使用当前模型，结束后自动切换。" : "切换后将沿用当前对话。"}
            <br />新模型对历史的理解可能不同；窗口较小时可能需要压缩历史，部分细节可能丢失。
          </>
        ) : undefined}
        model={s.selectedModel ?? undefined}
        onModelChange={(ref) => void store.selectModel(ref)}
        modes={showModes ? MODES : []}
        mode={s.permissionMode}
        onModeChange={(m) =>
          void store.setPermissionMode(m === "full" ? "full" : "default")
        }
        trailingAction={s.thinkingLevels.some((level) => level !== "off") ? (
          <Select
            value={s.thinkingLevel}
            onValueChange={(value) => {
              const level = s.thinkingLevels.find((level) => level === value);
              if (level) void store.setThinkingLevel(level);
            }}
            disabled={s.trust === "untrusted" || running || s.thinkingLevels.length < 2}
          >
            <SelectTrigger className="h-8 w-auto rounded-xl border-0 bg-transparent px-2 py-0 text-xs hover:bg-muted focus-visible:ring-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Brain className="size-3.5 shrink-0" />
                <span>思考强度：{EFFORT_LABELS[s.thinkingLevel]}</span>
              </span>
            </SelectTrigger>
            <SelectContent className="right-auto w-44 shadow-none">
              {s.thinkingLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {EFFORT_LABELS[level]} · {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        onSubmit={(text) => void store.prompt(text)}
      />

    </div>
  );
}
