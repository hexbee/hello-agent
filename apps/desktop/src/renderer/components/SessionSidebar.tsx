import { FolderPlus, MessageSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMenuControls,
  type SidebarResourceMove,
} from "./agents/ai-sidebar";
import { store, useStore, type StoreState } from "../store";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** store 的 projects → 项目树：项目为父节点（kind: project），会话为子节点（kind: file）。 */
function toTree(s: StoreState): SidebarResource[] {
  return s.projects.map((p) => ({
    id: p.cwd,
    label: p.name || basename(p.cwd),
    kind: "project" as const,
    children: p.sessions.map((sess) => ({
      id: sess.file,
      label: sess.name || basename(sess.file).replace(/\.jsonl$/, ""),
      kind: "file" as const,
    })),
  }));
}

export function SessionSidebar() {
  const s = useStore();
  const activeId = s.session?.file ?? null;
  const items = toTree(s);

  const findProjectOf = (file: string): string | null =>
    s.projects.find((p) => p.sessions.some((sess) => sess.file === file))?.cwd ?? null;

  /** 会话归属固定项目，跨项目拖拽无意义：一律拒绝 → 乐观移动自动回滚。 */
  const rejectMove = async (_event: SidebarResourceMove) => {
    throw new Error("sessions are bound to their project");
  };

  const rename = async (item: SidebarResource, label: string) => {
    if (item.id !== activeId) {
      // 只有当前打开的会话支持重命名（API 作用于当前 session），
      // reject 让乐观重命名回滚。
      throw new Error("只能重命名当前会话");
    }
    await store.renameSession(label);
  };

  const select = (id: string) => {
    if (id === activeId) return;
    const projectCwd = findProjectOf(id);
    if (!projectCwd) return;
    if (projectCwd === s.cwd) {
      // 当前项目内的会话：直接切换。
      void store.openSession(id);
    } else {
      // 其他项目：先切工作区（恢复信任 + 重建 runtime），再打开会话。
      void store.openProject(projectCwd).then(() => store.openSession(id));
    }
  };

  const renderMenu = (item: SidebarResource, controls: SidebarResourceMenuControls) => {
    if (item.kind === "project") {
      return null; // 项目行用默认展开/收起行为即可
    }
    const isCurrentProject = findProjectOf(item.id) === s.cwd;
    return (
      <>
        <button
          type="button"
          onClick={() => controls.rename()}
          disabled={item.id !== activeId}
          title={item.id !== activeId ? "只能重命名当前会话" : undefined}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          重命名
        </button>
        <div aria-hidden="true" className="my-1 h-px bg-border" />
        <button
          type="button"
          disabled={!isCurrentProject}
          title={!isCurrentProject ? "先切换到该项目再删除" : undefined}
          onClick={() => {
            controls.close();
            if (isCurrentProject && confirm("删除该会话？（移到系统废纸篓）")) {
              void store.deleteSession(item.id);
            }
          }}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-danger outline-none transition-colors hover:bg-muted disabled:opacity-40"
        >
          <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
          删除
        </button>
      </>
    );
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-2 px-3 py-3">
        <button
          className="flex-1 cursor-pointer rounded-lg bg-accent/90 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          onClick={() => void store.newSession()}
        >
          ＋ 新会话
        </button>
        <button
          className="flex cursor-pointer items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-fg"
          title="打开新的项目文件夹"
          onClick={() => void store.openWorkspace()}
        >
          <FolderPlus aria-hidden="true" className="size-3.5" />
          项目
        </button>
      </div>

      {/* relative：滚动容器成为内部绝对定位元素（AISidebar 的 sr-only 无障碍
          播报区等）的包含块，避免其以 ICB 定位逃出 overflow 裁剪，把整个
          文档撑出多余的右侧滚动条。 */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2">
        {items.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">暂无项目，点击「项目」打开文件夹</p>
        ) : (
          // key=项目数：项目增减时重挂载，让新项目按默认展开状态出现
          <AISidebar
            key={items.length}
            items={items}
            defaultExpandedIds={items.map((p) => p.id)}
            activeId={activeId}
            onActiveChange={select}
            onMove={rejectMove}
            onRename={rename}
            renderIcon={(item) =>
              item.kind === "project" ? undefined : (
                <MessageSquare aria-hidden="true" className="size-4 shrink-0" />
              )
            }
            renderMenu={renderMenu}
            ariaLabel="项目与会话"
          />
        )}
      </div>

      {s.forkCandidates.length > 0 && <ForkSection />}

      <div className="border-t border-border px-3 py-2">
        <button
          className="cursor-pointer text-xs text-muted-foreground hover:text-fg"
          onClick={() => void store.closeWorkspace()}
        >
          关闭工作区
        </button>
      </div>
    </aside>
  );
}

function ForkSection() {
  const s = useStore();
  const [forkOpen, setForkOpen] = useState(false);

  return (
    <div className="border-t border-border px-3 py-2">
      <button
        className="flex w-full cursor-pointer items-center justify-between text-xs text-muted-foreground hover:text-fg"
        onClick={() => setForkOpen(!forkOpen)}
      >
        从历史分叉 <span>{forkOpen ? "▾" : "▸"}</span>
      </button>
      {forkOpen && (
        <div className="mt-1 max-h-40 overflow-y-auto">
          {s.forkCandidates.map((c) => (
            <button
              key={c.entryId}
              className="block w-full cursor-pointer truncate rounded px-1 py-1 text-left text-[11px] text-muted-foreground hover:bg-panel-2 hover:text-fg"
              title={c.text}
              onClick={() => void store.fork(c.entryId)}
            >
              ⎇ {c.text.slice(0, 40) || "(空消息)"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
