import { store, useStore } from "../store";
import { AuthDialog } from "./AuthDialog";
import { ChatView } from "./ChatView";
import { SessionSidebar } from "./SessionSidebar";
import { TopBar } from "./TopBar";
import { WorkspaceGate } from "./WorkspaceGate";

export function App() {
  const s = useStore();

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {s.banner && (
        <div
          className={`flex items-center justify-between px-4 py-2 text-sm ${
            s.banner.kind === "error"
              ? "bg-danger/15 text-danger"
              : "bg-accent/15 text-accent"
          }`}
        >
          <span className="truncate">{s.banner.text}</span>
          <button
            className="ml-4 shrink-0 cursor-pointer opacity-70 hover:opacity-100"
            onClick={() => store.dismissBanner()}
          >
            ✕
          </button>
        </div>
      )}

      {s.phase === "gate" ? (
        <WorkspaceGate />
      ) : (
        <div className="flex min-h-0 flex-1">
          <SessionSidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar />
            {s.agentState === "failed" && (
              <div className="flex items-center justify-between border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-xs text-danger">
                <span>Agent 异常停止，输入已停用</span>
                <button
                  className="cursor-pointer rounded border border-danger/40 px-2 py-0.5 hover:bg-danger/20"
                  onClick={() => void store.rebuild()}
                >
                  重建 Runtime
                </button>
              </div>
            )}
            <ChatView />
          </div>
        </div>
      )}

      <AuthDialog />
    </div>
  );
}
