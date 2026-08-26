import { useState } from "react";
import { store, useStore } from "../store";

// §8 auth flow UI — provider select + API key entry. Raw keys live only in
// Main; the renderer receives back a masked auth state.
export function AuthDialog() {
  const s = useStore();
  const [providerId, setProviderId] = useState("");
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!s.authDialogOpen) return null;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[420px] rounded-xl border border-border bg-panel p-6 shadow-2xl">
        <h2 className="text-base font-semibold">配置 Provider 凭据</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          API key 将保存在系统安全存储（macOS 钥匙串），应用与 Pi CLI 的凭据互相隔离。
        </p>

        {s.authState.storageError && (
          <p className="mt-3 rounded-lg bg-danger/15 px-3 py-2 text-xs text-danger">
            {s.authState.storageError}
          </p>
        )}

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
                if (e.key === "Escape") store.closeAuthDialog();
              }}
            />
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-panel-2"
            onClick={() => store.closeAuthDialog()}
          >
            取消
          </button>
          <button
            className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!selected || !key.trim() || submitting}
            onClick={submit}
          >
            {submitting ? "验证中…" : "保存并验证"}
          </button>
        </div>
      </div>
    </div>
  );
}
