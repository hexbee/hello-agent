import { store, useStore } from "../store";

// §4.1 open-workspace state machine, UI side: SelectFolder → TrustCheck →
// RequestTrust. Untrusted shows directory info only — no runtime is created.
export function WorkspaceGate() {
  const s = useStore();

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex w-[420px] flex-col gap-6 rounded-xl border border-border bg-panel p-8">
        <div>
          <h1 className="text-lg font-semibold">hello-agent</h1>
          <p className="mt-1 text-sm text-muted-foreground">本地 coding agent 桌面客户端</p>
        </div>

        {!s.cwd ? (
          <>
            <p className="text-sm text-muted-foreground">选择一个项目目录开始。</p>
            <button
              className="cursor-pointer rounded-lg bg-accent px-4 py-2 font-medium text-white hover:opacity-90"
              onClick={() => void store.openWorkspace()}
            >
              打开文件夹…
            </button>
            {s.projects.length > 0 && (
              <div>
                <div className="mb-2 text-xs text-muted-foreground">最近的项目</div>
                <div className="flex flex-col gap-1">
                  {s.projects.map((p) => (
                    <button
                      key={p.cwd}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-panel-2"
                      onClick={() => void store.openProject(p.cwd)}
                    >
                      <span className="truncate font-medium">{p.name || p.cwd.split("/").pop()}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {p.sessions.length > 0 ? `${p.sessions.length} 个会话` : "无会话"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="rounded-lg border border-border bg-panel-2 p-3">
              <div className="text-xs text-muted-foreground">工作区</div>
              <div className="mt-1 truncate font-mono text-sm">{s.cwd}</div>
            </div>

            {s.trust === "untrusted" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  选择信任级别。受限模式只允许只读工具（read / grep / find / ls，限工作区内）；
                  完全信任允许写文件与 bash，但每次执行仍需审批。
                </p>
                <div className="flex gap-3">
                  <button
                    className="flex-1 cursor-pointer rounded-lg border border-border px-4 py-2 text-sm hover:bg-panel-2"
                    onClick={() => void store.setTrust("restricted")}
                  >
                    受限（只读）
                  </button>
                  <button
                    className="flex-1 cursor-pointer rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                    onClick={() => void store.setTrust("trusted")}
                  >
                    完全信任
                  </button>
                </div>
                <button
                  className="cursor-pointer text-xs text-muted-foreground hover:text-fg"
                  onClick={() => void store.closeWorkspace()}
                >
                  ← 选择其他目录
                </button>
              </>
            ) : (
              <button
                className="cursor-pointer rounded-lg bg-accent px-4 py-2 font-medium text-white hover:opacity-90"
                onClick={() => void store.enterWorkspace()}
              >
                进入工作区
              </button>
            )}
          </>
        )}

        {!s.authState.configured && (
          <p className="text-xs text-muted-foreground">
            未检测到已配置的 provider 凭据。v0.1 通过启动应用的环境变量提供 API key
            （如 ANTHROPIC_API_KEY）。
          </p>
        )}
      </div>
    </div>
  );
}
