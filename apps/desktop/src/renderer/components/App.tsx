import { PanelLeft } from "lucide-react";
import { store, useStore } from "../store";
import { isMac } from "../platform";
import { SettingsDialog } from "./SettingsDialog";
import { ChatView } from "./ChatView";
import {
  AnimatedSidebarInset,
  AnimatedSidebarProvider,
  AnimatedSidebarTrigger,
} from "./motion/animated-sidebar";
import { SessionSidebar } from "./SessionSidebar";
import { TopBar } from "./TopBar";

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

      {/* 不再展示 gate 首页：即使没有打开项目，也直接进入 agent 对话页。 */}
      <AnimatedSidebarProvider
        defaultSidebarWidth={240}
        className="min-h-0 flex-1"
      >
        <WindowControlsRow />
        <SessionSidebar />
        <AnimatedSidebarInset>
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
          {/* key 跟随会话 id：切换/新建会话时整体重挂载，
              复位 MessageScroller 的跟随状态与滚动位置，
              避免旧会话遗留的「回到底部」按钮出现在新会话页。 */}
          <ChatView key={s.session?.id ?? "none"} />
        </AnimatedSidebarInset>
      </AnimatedSidebarProvider>

      <SettingsDialog />
    </div>
  );
}

/**
 * macOS 无边框窗口：固定在窗口左上角的控制行——红绿灯占位（拖拽区）+ 侧边栏
 * 折叠开关。不随侧边栏折叠而消失：折叠后开关与红绿灯叠在顶栏上方，位置不变
 * （对齐 Codex）。非 macOS 有原生标题栏，无需此行。
 *
 * 注意：折叠按钮周围（含下层元素）不能有任何 drag 盒子——drag 区域的命中
 * 测试发生在真实输入层，按钮被 drag 盒子覆盖时点击会被窗口拖拽吞掉。
 * 因此 drag 区收缩到只盖红绿灯的 20px 占位条（侧边栏顶部条同理），
 * 按钮完全在 drag 区域之外，不依赖 no-drag carve-out。
 */
function WindowControlsRow() {
  if (!isMac) return null;
  return (
    <div className="fixed left-0 top-0 z-40 flex h-10 items-center">
      {/* 红绿灯占位：trafficLightPosition {x:16,y:14}，三枚共占约 68px 宽。 */}
      <span aria-hidden="true" className="app-drag h-full w-20 shrink-0" />
      <AnimatedSidebarTrigger
        className="ml-1 size-7 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-fg"
        title="折叠/展开侧边栏 (⌘/Ctrl+B)"
      >
        <PanelLeft aria-hidden="true" className="size-4" />
      </AnimatedSidebarTrigger>
    </div>
  );
}
