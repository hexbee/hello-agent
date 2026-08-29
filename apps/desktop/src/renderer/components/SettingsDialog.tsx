import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Search,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { store, useStore } from "../store";

/**
 * 设置弹层：目前只有「服务商凭据」一个分区。
 * 结构：顶部标题栏（标题 + 关闭）＋ 内容面板。Esc / 点击遮罩关闭。
 */
export function SettingsDialog() {
  const s = useStore();

  useEffect(() => {
    if (!s.settingsOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") store.closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.settingsOpen]);

  if (!s.settingsOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => store.closeSettings()}
    >
      <div
        role="dialog"
        aria-label="设置"
        className="flex h-[560px] w-[680px] flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">设置</h2>
          <button
            aria-label="关闭设置"
            className="cursor-pointer rounded-lg p-1.5 text-muted-foreground outline-none transition-colors hover:bg-panel-2 hover:text-fg"
            onClick={() => store.closeSettings()}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>

        <section className="min-h-0 flex-1 overflow-y-auto p-5">
          <ProviderCredentials />
        </section>
      </div>
    </div>
  );
}

/** 服务商凭据：可搜索的 provider 列表 + 内联密钥表单。 */
function ProviderCredentials() {
  const s = useStore();
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 两段式移除确认：置位后按钮变为「确认移除？」，3 秒未点自动复位。 */
  const [armRemove, setArmRemove] = useState<string | null>(null);
  const armTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(armTimer.current), []);

  const keyProviders = s.authProviders.filter((p) => p.supportsApiKey);
  const q = query.trim().toLowerCase();
  const matches = keyProviders.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q),
  );
  const sorted = [...matches].sort(
    (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
  );
  const configured = sorted.filter((p) => p.configured);
  const unconfigured = sorted.filter((p) => !p.configured);

  const open = (id: string): void => {
    setExpandedId(id);
    setKey("");
    setError(null);
    setShowKey(false);
    setArmRemove(null);
  };

  const submit = async (providerId: string): Promise<void> => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    const err = await store.submitApiKey(providerId, key.trim());
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setExpandedId(null);
    setKey("");
    setShowKey(false);
  };

  const remove = async (providerId: string): Promise<void> => {
    if (armRemove !== providerId) {
      setArmRemove(providerId);
      window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmRemove(null), 3_000);
      return;
    }
    window.clearTimeout(armTimer.current);
    setArmRemove(null);
    setBusy(true);
    const err = await store.removeApiKey(providerId);
    setBusy(false);
    setError(err);
    // 仅成功时折叠；失败保持展开以展示内联错误。
    if (!err) setExpandedId(null);
  };

  const renderRow = (p: (typeof sorted)[number]): React.ReactNode => {
    const expanded = expandedId === p.id;
    return (
      <div key={p.id} className={expanded ? "bg-accent-subtle/60" : undefined}>
        {/* 行头：点击展开/收起密钥表单 */}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => (expanded ? setExpandedId(null) : open(p.id))}
          className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left outline-none transition-colors hover:bg-panel-2"
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${
              p.configured ? "bg-ok" : "bg-border"
            }`}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
          {p.configured && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-ok">
              <Check aria-hidden="true" className="size-3" />
              已配置
            </span>
          )}
          {p.configured && p.hint && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {p.hint}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>

        {/* 展开：内联密钥表单 */}
        {expanded && (
          <div className="border-t border-border/60 px-3 pb-4 pt-3">
            <label
              htmlFor={`cred-key-${p.id}`}
              className="block text-xs text-muted-foreground"
            >
              API 密钥
            </label>
            <div className="relative mt-1.5">
              <input
                id={`cred-key-${p.id}`}
                autoFocus
                type={showKey ? "text" : "password"}
                value={key}
                disabled={busy}
                placeholder={p.configured && p.hint ? `当前密钥 ${p.hint}` : "sk-…"}
                className="w-full rounded-lg border border-border bg-bg py-2 pl-3 pr-9 font-mono text-sm outline-none transition-colors focus:border-accent disabled:opacity-60"
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit(p.id);
                }}
              />
              <button
                type="button"
                aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-muted-foreground outline-none transition-colors hover:text-fg"
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? (
                  <EyeOff aria-hidden="true" className="size-4" />
                ) : (
                  <Eye aria-hidden="true" className="size-4" />
                )}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              密钥加密保存在本机（macOS 钥匙串），与 Pi CLI 互不影响；保存时会先校验有效性。
            </p>
            {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={!key.trim() || busy}
                className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white outline-none transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void submit(p.id)}
              >
                {busy ? "验证中…" : "保存并验证"}
              </button>
              {p.configured && p.removable && (
                <button
                  type="button"
                  disabled={busy}
                  className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    armRemove === p.id
                      ? "bg-danger font-medium text-white hover:opacity-90"
                      : "text-danger hover:bg-danger/10"
                  }`}
                  onClick={() => void remove(p.id)}
                >
                  {armRemove === p.id ? "确认移除？" : "移除凭据"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (keyProviders.length === 0) {
    return (
      <div>
        <h3 className="text-base font-semibold">服务商凭据</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          配置 API 密钥后即可在模型选择器中使用对应模型。
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          没有找到可配置的服务商，请确认应用版本包含内置模型。
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-base font-semibold">服务商凭据</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        配置 API 密钥后即可在模型选择器中使用对应模型。密钥加密保存在本机（macOS
        钥匙串），与 Pi CLI 互不影响。
      </p>

      {/* 搜索 */}
      <div className="relative mt-4">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={query}
          placeholder="搜索服务商…"
          className="w-full rounded-lg border border-border bg-bg py-2 pl-8 pr-3 text-sm outline-none transition-colors focus:border-accent"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* 已配置 */}
      {configured.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            已配置 · {configured.length}
          </p>
          <div className="overflow-hidden rounded-xl border border-border bg-panel-2/60 divide-y divide-border/60">
            {configured.map(renderRow)}
          </div>
        </div>
      )}

      {/* 其他服务商 */}
      {unconfigured.length > 0 && (
        <div className={configured.length > 0 ? "mt-5" : "mt-4"}>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            其他服务商 · {unconfigured.length}
          </p>
          <div className="overflow-hidden rounded-xl border border-border bg-panel-2/60 divide-y divide-border/60">
            {unconfigured.map(renderRow)}
          </div>
        </div>
      )}

      {matches.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          没有匹配「{query.trim()}」的服务商。
        </p>
      )}
    </div>
  );
}
