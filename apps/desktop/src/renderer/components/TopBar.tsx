import { ChevronRight, Folder, PanelLeft } from "lucide-react";
import { useStore } from "../store";
import { isMac } from "../platform";
import { AnimatedSidebarTrigger, useAnimatedSidebar } from "./motion/animated-sidebar";

export function TopBar() {
  const s = useStore();
  // macOS 无边框窗口：侧边栏折叠（offcanvas）后红绿灯 + 固定折叠开关叠在
  // 顶栏上方，左侧留出等宽内边距避免文字与之重叠。
  const { open } = useAnimatedSidebar();
  // 窗口拖拽层的左起点：必须避开固定控制行/折叠按钮（drag 盒子盖住按钮时，
  // 真实点击会被窗口拖拽吞掉 —— 折叠态顶栏从 x=0 铺开正好盖住按钮）。
  // 非 macOS 折叠按钮在顶栏内（约 60px 宽），同样避开。
  const dragLeft = isMac ? (open ? 0 : 120) : 60;

  return (
    <div
      className={`relative isolate flex min-h-10 items-center gap-3 border-b border-border bg-panel px-3 py-1 ${
        isMac && !open ? "pl-[116px]" : ""
      }`}
    >
      {/* 窗口拖拽层：铺满顶栏但避开按钮；文字内容在其上方（均非交互元素）。 */}
      <div
        aria-hidden="true"
        className="app-drag absolute inset-y-0 -z-10 right-0"
        style={{ left: dragLeft }}
      />
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {!isMac && (
          <AnimatedSidebarTrigger
            className="-ml-1.5 text-muted-foreground transition-colors hover:text-fg"
            title={"折叠/展开侧边栏 (⌘/Ctrl+B)"}
          >
            <PanelLeft aria-hidden="true" className="size-4" />
          </AnimatedSidebarTrigger>
        )}
        <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-muted-foreground" title={s.cwd}>
          {s.cwd.split("/").pop() || s.cwd}
        </span>
        {/* 当前会话名（自动起标题/手动改名后才有）：新会话不展示。 */}
        {s.session?.name && (
          <>
            <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/60" />
            <span
              className="truncate text-xs text-fg"
              title={s.session.name}
            >
              {s.session.name}
            </span>
          </>
        )}
      </div>

      <div className="flex-1" />
    </div>
  );
}
