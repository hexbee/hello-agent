import {
  ArrowDown,
  ArrowUp,
  Clock3,
  FolderMinus,
  GitPullRequest,
  MessageSquare,
  Pencil,
  Plug,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  AnimatedSidebar,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
} from "./motion/animated-sidebar";
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

  /**
   * 移动处理：项目行允许上移/下移重排（并持久化到主进程保存顺序）；
   * 会话移动与项目嵌套（inside）一律拒绝，由 AISidebar 乐观回滚。
   */
  const onMove = (move: SidebarResourceMove) => {
    const projects = s.projects;
    const isProject = projects.some((p) => p.cwd === move.itemId);
    if (!isProject) {
      // 会话归属固定项目，不参与拖动排序。
      return Promise.reject(new Error("sessions are bound to their project"));
    }
    const order = projects.map((p) => p.cwd);
    const from = order.indexOf(move.itemId);
    if (from === -1) return Promise.reject(new Error("invalid move source"));

    // 把任意落点归一到顶层项目兄弟。目标可直接是项目；也可能是某项目下的
    // 会话（此时以其父项目为准）；或空区域（targetId === null，移到末尾）。
    // 项目不支持嵌套，position 一律按 before/after 处理（inside 视为 after）。
    let targetCwd: string | null = null;
    if (move.targetId !== null) {
      if (projects.some((p) => p.cwd === move.targetId)) {
        targetCwd = move.targetId;
      } else {
        const parent = projects.find((p) =>
          p.sessions.some((sess) => sess.file === move.targetId),
        );
        targetCwd = parent?.cwd ?? null;
      }
    }
    if (targetCwd === move.itemId) {
      // 落在自身：无变化。
      return store.reorderProjects(order);
    }
    order.splice(from, 1);
    const position = move.position === "before" ? "before" : "after";
    if (targetCwd === null) {
      order.push(move.itemId);
    } else {
      let to = order.indexOf(targetCwd);
      if (to === -1) order.push(move.itemId);
      else {
        if (position === "after") to += 1;
        order.splice(to, 0, move.itemId);
      }
    }
    return store.reorderProjects(order);
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
      // 项目行：重命名 + 上移/下移（重排项目并持久化）+ 移除项目。
      // 不提供「移入/移出」——项目是顶层容器，不建议嵌套；
      // 重命名只作用于当前会话（点击后会失败回滚，这是原有行为）。
      const { moves } = controls;
      const actionClass =
        "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring";
      const runMove = (move: () => void) => () => {
        controls.close();
        move();
      };
      return (
        <>
          <button type="button" onClick={() => controls.rename()} className={actionClass}>
            <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
            重命名
          </button>
          {moves.up || moves.down ? (
            <div aria-hidden="true" className="my-1 h-px bg-border" />
          ) : null}
          {moves.up ? (
            <button type="button" onClick={runMove(moves.up)} className={actionClass}>
              <ArrowUp aria-hidden="true" className="size-3.5 shrink-0" />
              上移
            </button>
          ) : null}
          {moves.down ? (
            <button type="button" onClick={runMove(moves.down)} className={actionClass}>
              <ArrowDown aria-hidden="true" className="size-3.5 shrink-0" />
              下移
            </button>
          ) : null}
          <div aria-hidden="true" className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              controls.close();
              if (
                confirm(
                  `移除项目「${item.label}」？\n仅从侧边栏列表移除，会话文件会保留，之后可通过「项目」重新添加。`,
                )
              ) {
                void store.removeProject(item.id);
              }
            }}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-danger outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FolderMinus aria-hidden="true" className="size-3.5 shrink-0" />
            移除项目
          </button>
        </>
      );
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
    <AnimatedSidebar
      collapsible="offcanvas"
      resizable
      ariaLabel="项目与会话"
    >
      {/* 子层铺满面板并接管背景色：面板默认 bg-background，与应用的
          bg-panel 不同；直接传 panelClassName 会与默认类产生同类
          utility 冲突（谁赢取决于样式表顺序），用铺满的子层最稳。 */}
      <div className="flex h-full min-h-0 flex-col bg-panel">
        {/* 顶部操作区：复刻 docs/ai-sidebar.md 的 action 菜单（新对话 / Pull Request / 已安排 / 插件）。
            其余三项为空实现，仅“新对话”及右侧 + 按钮实际生效（新建会话 / 打开项目）。 */}
        <AnimatedSidebarMenu className="gap-1 px-2 py-3">
          <AnimatedSidebarMenuItem>
            <div className="flex items-center">
              <AnimatedSidebarMenuButton
                icon={<SquarePen className="size-4" />}
                onSelect={() => void store.newSession()}
                disabled={!s.cwd}
                className="flex-1 font-normal text-foreground"
              >
                新对话
              </AnimatedSidebarMenuButton>
              <button
                type="button"
                title="打开新的项目文件夹"
                onClick={() => void store.openWorkspace()}
                className="relative z-10 mr-1.5 grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-fg"
              >
                <Plus aria-hidden="true" className="size-4" />
              </button>
            </div>
          </AnimatedSidebarMenuItem>
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton
              icon={<GitPullRequest className="size-4" />}
              onSelect={() => {}}
              className="font-normal text-foreground"
            >
              Pull Request
            </AnimatedSidebarMenuButton>
          </AnimatedSidebarMenuItem>
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton
              icon={<Clock3 className="size-4" />}
              onSelect={() => {}}
              className="font-normal text-foreground"
            >
              已安排
            </AnimatedSidebarMenuButton>
          </AnimatedSidebarMenuItem>
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton
              icon={<Plug className="size-4" />}
              onSelect={() => {}}
              className="font-normal text-foreground"
            >
              插件
            </AnimatedSidebarMenuButton>
          </AnimatedSidebarMenuItem>
        </AnimatedSidebarMenu>

        {/* relative：滚动容器成为内部绝对定位元素（AISidebar 的 sr-only 无障碍
            播报区等）的包含块，避免其以 ICB 定位逃出 overflow 裁剪，把整个
            文档撑出多余的右侧滚动条。 */}
        <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2">
          <AnimatedSidebarGroupLabel className="mb-1 h-8 px-2 text-xs font-medium normal-case tracking-normal">
            项目
          </AnimatedSidebarGroupLabel>
          {items.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">暂无项目，点击「项目」打开文件夹</p>
          ) : (
            // 不用 key=项目数 重挂载：否则增删项目会重置整个展开状态。AISidebar
            // 内部记住折叠状态，仅对真正新增的项目自动展开（见 ai-sidebar）。
            <AISidebar
              items={items}
              defaultExpandedIds={items.map((p) => p.id)}
              activeId={activeId}
              onActiveChange={select}
              onMove={onMove}
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
      </div>
    </AnimatedSidebar>
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
