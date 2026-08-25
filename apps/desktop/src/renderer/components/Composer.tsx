import { Cpu } from "lucide-react";
import type { PromptModel } from "./agents/prompt-input";
import { PromptInput } from "./agents/prompt-input";
import { store, useStore } from "../store";

// beUI PromptInput: auto-grow textarea + inline model select + animated
// send/stop. IME-safe Enter submission is built into the component.
// CSP note (§3.3): provider icons are local lucide glyphs, never remote favicons.
export function Composer() {
  const s = useStore();

  const models: PromptModel[] = s.models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.id}`,
    icon: <Cpu />,
  }));

  const running = s.agentState === "running";

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
        onSubmit={(text) => void store.prompt(text)}
      />
    </div>
  );
}
