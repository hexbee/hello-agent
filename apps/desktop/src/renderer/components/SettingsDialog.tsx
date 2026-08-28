import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { store, useStore } from "../store";

type SectionId = "provider";

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: "provider", label: "Provider 凭据", icon: <KeyRound aria-hidden="true" /> },
];

/**
 * 设置页弹层：左侧分区导航 + 右侧内容面板。
 * 目前只有「配置 Provider 凭据」一个分区（原 AuthDialog 的能力并入这里）。
 */
export function SettingsDialog() {
  const s = useStore();
  const [section, setSection] = useState<SectionId>("provider");

  if (!s.settingsOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => store.closeSettings()}
    >
      <div
        role="dialog"
        aria-label="设置"
        className="flex h-[420px] w-[640px] overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧分区导航 */}
        <aside className="flex w-[172px] shrink-0 flex-col border-r border-border p-3">
          <h2 className="px-2 py-1 text-sm font-semibold">设置</h2>
          <nav className="mt-2 flex flex-col gap-0.5">
            {SECTIONS.map((sec) => {
              const active = sec.id === section;
              return (
                <button
                  key={sec.id}
                  onClick={() => setSection(sec.id)}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none transition-colors ${
                    active
                      ? "bg-accent/15 font-medium text-accent"
                      : "text-muted-foreground hover:bg-panel-2 hover:text-fg"
                  }`}
                >
                  <span aria-hidden="true" className="size-3.5 shrink-0 [&>svg]:size-3.5">
                    {sec.icon}
                  </span>
                  {sec.label}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* 右侧内容面板 */}
        <section className="min-w-0 flex-1 overflow-y-auto p-5">
          {section === "provider" && <ProviderCredentials />}
        </section>
      </div>
    </div>
  );
}

/** 配置 Provider 凭据：provider 选择 + API key 输入，保存到系统安全存储。 */
function ProviderCredentials() {
  const s = useStore();
  const [providerId, setProviderId] = useState("");
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const keyProviders = s.authProviders.filter((p) => p.supportsApiKey);
  const selected = providerId || keyProviders[0]?.id || "";

  const submit = (): void => {
    if (!selected || !key.trim() || submitting) return;
    setSubmitting(true);
    void store
      .submitApiKey(selected, key.trim())
      .finally(() => {
        setSubmitting(false);
        setKey("");
      });
  };

  return (
    <div>
      <h3 className="text-base font-semibold">配置 Provider 凭据</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        API key 将保存在系统安全存储（macOS 钥匙串），应用与 Pi CLI 的凭据互相隔离。
      </p>

      {/* 当前凭据状态 */}
      <div className="mt-4 rounded-lg border border-border bg-panel-2 px-3 py-2 text-xs">
        {s.authState.configured ? (
          <span className="text-muted-foreground">
            当前：<span className="text-fg">{s.authState.provider}</span>{" "}
            {s.authState.maskedHint ?? ""}
          </span>
        ) : (
          <span className="text-muted-foreground">尚未配置凭据，配置后即可选择模型开始对话。</span>
        )}
        {s.authState.storageError && (
          <p className="mt-2 text-danger">{s.authState.storageError}</p>
        )}
      </div>

      {keyProviders.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          未发现可配置的 provider。请确认应用版本包含内置模型目录。
        </p>
      ) : (
        <>
          <label className="mt-4 block text-xs text-muted-foreground">Provider</label>
          <select
            className="mt-1 w-full cursor-pointer rounded-lg border border-border bg-panel-2 px-2 py-2 text-sm outline-none focus:border-accent"
            value={selected}
            onChange={(e) => setProviderId(e.target.value)}
          >
            {keyProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.configured ? "（已配置）" : ""}
              </option>
            ))}
          </select>

          <label className="mt-3 block text-xs text-muted-foreground">API Key</label>
          <input
            autoFocus
            type="password"
            value={key}
            placeholder={s.authState.maskedHint ? `当前：${s.authState.maskedHint}` : "sk-…"}
            className="mt-1 w-full rounded-lg border border-border bg-panel-2 px-2 py-2 font-mono text-sm outline-none focus:border-accent"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") store.closeSettings();
            }}
          />

          <div className="mt-4 flex justify-end">
            <button
              className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!selected || !key.trim() || submitting}
              onClick={submit}
            >
              {submitting ? "验证中…" : "保存并验证"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
