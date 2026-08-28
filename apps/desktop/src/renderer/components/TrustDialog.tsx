import { store, useStore } from "../store";

// 打开未信任目录时的信任级别确认弹窗（替代原 gate 首页的信任步骤）。
// 受限：只允许只读工具（read / grep / find / ls，限工作区内）；
// 完全信任：允许写文件与 bash，但每次执行仍需审批。
export function TrustDialog() {
  const s = useStore();
  if (!s.trustDialogOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[420px] rounded-xl border border-border bg-panel p-6 shadow-2xl">
        <h2 className="text-base font-semibold">选择信任级别</h2>
        <p className="mt-1 text-xs text-muted-foreground">工作区</p>
        <p className="mt-1 truncate font-mono text-sm text-foreground">{s.cwd}</p>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          受限模式只允许只读工具（read / grep / find / ls，限工作区内）；
          完全信任允许写文件与 bash，但每次执行仍需审批。
        </p>

        <div className="mt-5 flex gap-3">
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
          className="mt-4 cursor-pointer text-xs text-muted-foreground hover:text-fg"
          onClick={() => void store.closeWorkspace()}
        >
          ← 选择其他目录
        </button>
      </div>
    </div>
  );
}
