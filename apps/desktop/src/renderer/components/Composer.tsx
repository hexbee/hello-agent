import { Cpu, Shield, ShieldCheck } from "lucide-react";
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
    description: "只读自动放行，写文件 / 命令需审批",
    icon: <Shield />,
  },
  {
    value: "full",
    label: "完全访问",
    description: "所有工具自动放行，不再弹审批",
    icon: <ShieldCheck />,
  },
];

export function Composer() {
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
      <PromptInput
        placeholder={
          running ? "Agent 正在运行…" : "输入消息（Enter 发送，Shift+Enter 换行）"
        }
        aria-label="Prompt"
        disabled={s.trust === "untrusted"}
        loading={running}
        onStop={() => void store.abort()}
        models={models}
        model={s.selectedModel ?? undefined}
        onModelChange={(ref) => void store.selectModel(ref)}
        modes={showModes ? MODES : []}
        mode={s.permissionMode}
        onModeChange={(m) =>
          void store.setPermissionMode(m === "full" ? "full" : "default")
        }
        onSubmit={(text) => void store.prompt(text)}
      />
    </div>
  );
}
