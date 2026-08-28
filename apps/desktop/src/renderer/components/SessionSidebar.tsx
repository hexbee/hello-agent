import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock3,
  FolderMinus,
  FolderPlus,
  GitPullRequest,
  Loader,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AnimatedSidebar,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
} from "./motion/animated-sidebar";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "./motion/popover-morph";
import { cn } from "../lib/utils";
import { loadPref, savePref } from "../lib/ui-prefs";
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMenuControls,
  type SidebarResourceMove,
} from "./agents/ai-sidebar";
import { store, useStore, fileMatchesSession, type StoreState } from "../store";
import { isMac } from "../platform";
import { useTouchCapable } from "../lib/hooks/use-touch-capable";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** 每个项目展开时默认可见的会话数；「展开更多」每次追加同样数量。 */
const SESSION_PAGE_SIZE = 5;

/** 「项目」⋯ 菜单的动作项样式（与行内右键菜单一致）。 */
const MENU_ACTION_CLASS =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

/** 「项目」分区头右侧小圆钮的共用样式：默认隐藏，hover 行/键盘聚焦时出现。 */
const HEADER_BUTTON_CLASS =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/header:opacity-100";

/** store 的 projects → 项目树：项目为父节点（kind: project），会话为子节点（kind: file）。
 *  乐观会话（新会话首条消息已发出、.jsonl 未落盘）作为占位子节点插在最前
 *  （与落盘后按 modified 倒序的位置一致，落盘时行不跳动）：名字用问题开头字符，
 *  落盘未命名时占位名兜底显示，直到 LLM 标题接管；busy 标记渲染运行中指示器。 */
function toTree(s: StoreState): SidebarResource[] {
  return s.projects.map((p) => {
    const pending = s.optimisticSessions.filter(
      (o) =>
        o.projectCwd === p.cwd &&
        !p.sessions.some((sess) => fileMatchesSession(sess.file, o.sessionId)),
    );
    return {
      id: p.cwd,
      label: p.name || basename(p.cwd),
      kind: "project" as const,
      children: [
        ...pending.map((o) => ({
          id: `pending:${o.sessionId}`,
          label: o.name,
          kind: "file" as const,
          busy: o.running,
        })),
        ...p.sessions.map((sess) => {
          const opt = s.optimisticSessions.find((o) =>
            fileMatchesSession(sess.file, o.sessionId),
          );
          return {
            id: sess.file,
            label:
              sess.name || opt?.name || basename(sess.file).replace(/\.jsonl$/, ""),
            kind: "file" as const,
            busy: opt?.running,
          };
        }),
      ],
    };
  });
}

export function SessionSidebar() {
  const s = useStore();
  const activeId = s.session?.file ?? null;
  const items = toTree(s);
  // 项目行尾的「新对话」钮与 ⋯ 钮一致：hover 设备上悬停显示，触屏常显。
  const canTouch = useTouchCapable();
  // 「项目」分区整体折叠（Codex 侧边栏的「项目 ⌄」）——持久化。
  const [sectionOpen, setSectionOpen] = useState(() => loadPref("section-open", true));
  useEffect(() => {
    savePref("section-open", sectionOpen);
  }, [sectionOpen]);
  // 「项目」⋯ 菜单。
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  // 受控的各项目展开集合：本层持久化的是「已折叠项目」集合，未列入的一律展开
  //（新增项目默认展开；null = 从未手动折叠过，全部展开）。AISidebar 负责行渲染，
  // 本层持有状态以支持「全部展开/折叠」。
  // 注意键名 v2：v1 曾因展开/折叠集合语义反转写入过脏数据，改名丢弃。
  const [collapsedIds, setCollapsedIds] = useState<Set<string> | null>(() => {
    const saved = loadPref<string[] | null>("tree-collapsed-v2", null);
    return saved ? new Set(saved) : null;
  });
  useEffect(() => {
    if (collapsedIds !== null) savePref("tree-collapsed-v2", [...collapsedIds]);
  }, [collapsedIds]);
  // 传给 AISidebar 的生效展开集合 = 全部项目 − 已折叠（补集，切勿直接传 collapsedIds）。
  const expandedIds = useMemo(
    () =>
      collapsedIds === null
        ? new Set(s.projects.map((p) => p.cwd))
        : new Set(
            s.projects.map((p) => p.cwd).filter((cwd) => !collapsedIds.has(cwd)),
          ),
    [collapsedIds, s.projects],
  );
  // AISidebar 的 toggle/自动展开回报「新的完整展开集合」，反推持久化的折叠集合
  //（顺带清掉已移除项目的残留 id）。
  const onExpandedChange = useCallback(
    (ids: Set<string>) =>
      setCollapsedIds(
        new Set(s.projects.map((p) => p.cwd).filter((cwd) => !ids.has(cwd))),
      ),
    [s.projects],
  );
  const anyExpanded = items.some((p) => expandedIds.has(p.id));
  const allExpanded =
    items.length > 0 && items.every((p) => expandedIds.has(p.id));

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

  /** 项目行「新对话」：一键切到该项目目录并新建会话（跨项目复用 select 的切换链）。 */
  const newSessionInProject = (projectCwd: string) => {
    if (projectCwd === s.cwd) {
      void store.newSession();
    } else {
      void store.openProject(projectCwd).then(() => store.newSession());
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
        {/* 红绿灯留白条（仅 macOS 无边框窗口）：仅左侧 20px 覆盖红绿灯的区域是
            窗口拖拽区，其余留白不可 drag —— 避免任何 drag 盒子压在固定折叠
            按钮下方，导致点击被窗口拖拽吞掉。 */}
        {isMac && (
          <div className="flex h-10 shrink-0">
            <span aria-hidden="true" className="app-drag h-full w-20 shrink-0" />
            <span aria-hidden="true" className="h-full min-w-0 flex-1" />
          </div>
        )}
        {/* 顶部操作区：复刻 docs/ai-sidebar.md 的 action 菜单（新对话 / Pull Request / 已安排 / 插件）。
            其余三项为空实现，仅“新对话”实际生效（新建会话）。 */}
        <AnimatedSidebarMenu className="gap-1 px-2 py-3">
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton
              icon={<SquarePen className="size-4" />}
              onSelect={() => void store.newSession()}
              disabled={!s.cwd}
              className="font-normal text-foreground"
            >
              新对话
            </AnimatedSidebarMenuButton>
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
          {/* 「项目」分区头：点击标题折叠/展开整区；右侧 ⋯ 菜单与 + 新建项目
              （对应 Codex 侧边栏的 项目 ⌄ … + ）。group/header：⋯ 与 + 默认
              隐藏，悬停整行（或键盘聚焦）时出现；触屏无 hover 则常显。 */}
          <div className="group/header mb-1 flex h-8 items-center gap-0.5 pl-2 pr-0.5">
            <button
              type="button"
              aria-expanded={sectionOpen}
              aria-label={sectionOpen ? "折叠项目列表" : "展开项目列表"}
              onClick={() => setSectionOpen((open) => !open)}
              className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-lg text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  !sectionOpen && "-rotate-90",
                )}
              />
              <span className="truncate">项目</span>
            </button>
            <MorphPopover
              open={projectsMenuOpen}
              onOpenChange={setProjectsMenuOpen}
            >
              <MorphPopoverTrigger>
                <button
                  type="button"
                  aria-label="项目菜单"
                  title="项目菜单"
                  className={cn(
                    HEADER_BUTTON_CLASS,
                    // 菜单展开时鼠标可能移入弹层（离开行），⋯ 保持可见。
                    canTouch || projectsMenuOpen ? "opacity-100" : "opacity-0",
                  )}
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </button>
              </MorphPopoverTrigger>
              <MorphPopoverContent
                side="bottom"
                align="end"
                sideOffset={8}
                radius={12}
                className="w-44 p-1.5"
              >
                <button
                  type="button"
                  disabled={!allExpanded}
                  onClick={() => {
                    setProjectsMenuOpen(false);
                    setCollapsedIds(new Set());
                  }}
                  className={MENU_ACTION_CLASS}
                >
                  <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0" />
                  全部展开
                </button>
                <button
                  type="button"
                  disabled={!anyExpanded}
                  onClick={() => {
                    setProjectsMenuOpen(false);
                    setCollapsedIds(new Set(items.map((p) => p.id)));
                  }}
                  className={MENU_ACTION_CLASS}
                >
                  <ChevronsDownUp aria-hidden="true" className="size-3.5 shrink-0" />
                  全部折叠
                </button>
                <div aria-hidden="true" className="my-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={() => {
                    setProjectsMenuOpen(false);
                    void store.openWorkspace();
                  }}
                  className={MENU_ACTION_CLASS}
                >
                  <FolderPlus aria-hidden="true" className="size-3.5 shrink-0" />
                  打开项目文件夹
                </button>
              </MorphPopoverContent>
            </MorphPopover>
            <button
              type="button"
              aria-label="新建项目"
              title="新建项目（打开文件夹）"
              onClick={() => void store.openWorkspace()}
              className={cn(
                HEADER_BUTTON_CLASS,
                canTouch ? "opacity-100" : "opacity-0",
              )}
            >
              <Plus aria-hidden="true" className="size-4" />
            </button>
          </div>
          {sectionOpen ? (
            items.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">暂无项目，点击「项目」打开文件夹</p>
            ) : (
              // 不用 key=项目数 重挂载：否则增删项目会重置整个展开状态。AISidebar
              // 内部记住折叠状态，仅对真正新增的项目自动展开（见 ai-sidebar）。
              <AISidebar
                items={items}
                expandedIds={expandedIds}
                onExpandedChange={onExpandedChange}
                visibleChildren={SESSION_PAGE_SIZE}
                showMoreLabel="展开更多"
                activeId={activeId}
                onActiveChange={select}
                onMove={onMove}
                onRename={rename}
                renderIcon={(item) =>
                  item.kind === "project" ? undefined : (
                    <MessageSquare aria-hidden="true" className="size-4 shrink-0" />
                  )
                }
                renderTrailingAction={(item) => {
                  // 会话行运行中：行尾旋转指示器（新会话发出首条消息即出现）。
                  if (item.kind !== "project") {
                    return item.busy ? (
                      <Loader
                        aria-hidden="true"
                        className="size-3.5 shrink-0 animate-spin text-accent"
                      />
                    ) : undefined;
                  }
                  // 仅项目行提供「新对话」快捷钮：一键切目录 + 新建会话。
                  // 显隐样式与行内 ⋯ 钮完全一致（hover 显示、触屏常显）。
                  return (
                    <button
                      type="button"
                      draggable={false}
                      tabIndex={-1}
                      aria-label={`在 ${item.label} 中新建对话`}
                      title={`在 ${item.label} 中新建对话`}
                      onClick={(event) => {
                        event.stopPropagation();
                        newSessionInProject(item.id);
                      }}
                      className={cn(
                        "grid size-7 shrink-0 place-items-center rounded-lg outline-none transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100",
                        canTouch ? "opacity-100" : "opacity-0",
                      )}
                    >
                      <SquarePen aria-hidden="true" className="size-4" />
                    </button>
                  )
                }}
                renderMenu={renderMenu}
                ariaLabel="项目与会话"
              />
            )
          ) : null}
        </div>

        {s.forkCandidates.length > 0 && <ForkSection />}

        {/* 左下角设置入口：打开设置页（Provider 凭据等配置）。 */}
        <div className="border-t border-border px-3 py-2">
          <button
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-panel-2 hover:text-fg"
            onClick={() => store.openSettings()}
          >
            <Settings aria-hidden="true" className="size-3.5 shrink-0" />
            设置
          </button>
        </div>
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
