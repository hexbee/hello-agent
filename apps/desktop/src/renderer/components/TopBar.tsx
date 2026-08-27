import { PanelLeft } from "lucide-react";
import { store, useStore } from "../store";
import { AnimatedSidebarTrigger } from "./motion/animated-sidebar";

const TRUST_LABEL: Record<string, string> = {
  untrusted: "未信任",
  restricted: "受限",
  trusted: "已信任",
};

export function TopBar() {
  const s = useStore();

  const grouped = new Map<string, typeof s.models>();
  for (const m of s.models) {
    const list = grouped.get(m.provider) ?? [];
    list.push(m);
    grouped.set(m.provider, list);
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-panel px-4 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <AnimatedSidebarTrigger
          className="-ml-1.5 text-muted-foreground transition-colors hover:text-fg"
          title={"折叠/展开侧边栏 (⌘/Ctrl+B)"}
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </AnimatedSidebarTrigger>
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            s.agentState === "running"
              ? "animate-pulse bg-accent"
              : s.agentState === "failed"
                ? "bg-danger"
                : "bg-ok"
          }`}
        />
        <span className="truncate font-mono text-xs text-muted-foreground" title={s.cwd}>
          {s.cwd.split("/").pop() || s.cwd}
        </span>
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {TRUST_LABEL[s.trust]}
        </span>
      </div>

      <div className="flex-1" />

      <select
        className="max-w-[260px] cursor-pointer truncate rounded-lg border border-border bg-panel-2 px-2 py-1 text-xs outline-none"
        value={s.selectedModel ?? ""}
        onChange={(e) => void store.selectModel(e.target.value)}
      >
        <option value="" disabled>
          {s.authState.configured ? "选择模型…" : "无可用模型（检查凭据）"}
        </option>
        {[...grouped.entries()].map(([provider, models]) => (
          <optgroup key={provider} label={provider}>
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.id}
                {m.context ? ` (${Math.round(m.context / 1000)}k)` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {s.authState.configured ? (
        <button
          className="cursor-pointer text-xs text-muted-foreground hover:text-fg"
          title={`provider: ${s.authState.provider} · ${s.authState.maskedHint ?? ""}\n点击管理凭据`}
          onClick={() => store.openAuthDialog()}
        >
          🔑 {s.authState.provider} {s.authState.maskedHint ?? ""}
        </button>
      ) : (
        <button
          className="cursor-pointer rounded-lg bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30"
          onClick={() => store.openAuthDialog()}
        >
          配置凭据…
        </button>
      )}
    </div>
  );
}
