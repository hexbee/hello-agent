"use client";
// beui.dev/components/agents/ai-sidebar

import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  ChevronDown,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  type LucideIcon,
  MoreHorizontal,
  Pencil,
  Undo2,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { useTouchCapable } from "@/lib/hooks/use-touch-capable";
import { cn } from "@/lib/utils";

export type SidebarResourceKind =
  | "folder"
  | "project"
  | "file"
  | "bookmark";

export interface SidebarResource {
  id: string;
  label: string;
  kind: SidebarResourceKind;
  children?: SidebarResource[];
  disabled?: boolean;
  /** 行内忙碌（如会话正在运行）：宿主可通过 renderTrailingAction 渲染指示器。 */
  busy?: boolean;
}

export type SidebarResourceDropPosition = "before" | "inside" | "after";

export interface SidebarResourceMove {
  itemId: string;
  targetId: string | null;
  position: SidebarResourceDropPosition;
}

/**
 * The moves this row can make right now, the same four the keyboard offers on
 * `Alt+Shift+Arrow`. A pointer drag is the fast path for them; a finger has no
 * drag to give, so the row menu carries them too. Absent keys are moves this
 * row cannot make from where it sits.
 */
export interface SidebarResourceMoveCommands {
  up?: () => void;
  down?: () => void;
  into?: { label: string; run: () => void };
  out?: () => void;
}

export interface SidebarResourceMenuControls {
  close: () => void;
  rename: () => void;
  moves: SidebarResourceMoveCommands;
}

export interface AISidebarProps {
  items?: SidebarResource[];
  defaultItems?: SidebarResource[];
  onItemsChange?: (items: SidebarResource[]) => void;
  /** Reject the promise to roll the optimistic move back. */
  onMove?: (move: SidebarResourceMove) => void | Promise<void>;
  onMoveError?: (error: unknown, move: SidebarResourceMove) => void;
  onRename?: (item: SidebarResource, label: string) => void | Promise<void>;
  activeId?: string | null;
  defaultActiveId?: string | null;
  onActiveChange?: (id: string) => void;
  defaultExpandedIds?: string[];
  /** 受控展开集合；传入后展开状态完全由外部驱动，配合 onExpandedChange 使用。 */
  expandedIds?: Set<string>;
  onExpandedChange?: (ids: Set<string>) => void;
  /**
   * 展开容器默认可见的子节点上限（超出部分收进「展开更多」行，可分批展开）。
   * 数字作用于所有容器，函数按容器定制；undefined / ≤0 表示不限制。
   */
  visibleChildren?: number | ((item: SidebarResource) => number | undefined);
  /** 「展开更多」行文案。 */
  showMoreLabel?: string;
  renderIcon?: (item: SidebarResource) => ReactNode;
  renderMenu?: (
    item: SidebarResource,
    controls: SidebarResourceMenuControls,
  ) => ReactNode;
  /**
   * 行尾三点 ⋯ 按钮之后的额外动作位（如项目行的「新建对话」）。返回的节点
   * 渲染在 ⋯ 按钮右侧，行内 hover 显隐等样式由宿主自行套用（行是
   * group/resource，可用同样的 group-hover 类）。返回 undefined 表示无动作。
   */
  renderTrailingAction?: (item: SidebarResource) => ReactNode;
  ariaLabel?: string;
  className?: string;
}

interface FlatResource {
  item: SidebarResource;
  depth: number;
  parentId: string | null;
}

/** 「展开更多」行：某容器的子节点超出可见上限后的剩余提示。 */
interface FlatMoreRow {
  kind: "more";
  parentId: string;
  depth: number;
  hiddenCount: number;
}

type FlatEntry = { kind: "row"; row: FlatResource } | FlatMoreRow;

interface DropTarget {
  id: string | null;
  position: SidebarResourceDropPosition;
}

const ROW_REVEAL = {
  duration: 0.16,
  ease: EASE_OUT,
} as const;

function canContain(item: SidebarResource) {
  return item.kind === "folder" || item.kind === "project";
}

/**
 * The nearest flat row sharing `row`'s depth AND parent — its true sibling for
 * a same-level reorder. The raw adjacent flat row (`flat[index±1]`) may be the
 * row's own child (when expanded) or a cousin (after a sibling subtree), and
 * targeting it for up/down would reorder into the wrong place or no-op. Same
 * depth alone is not enough: rows at equal depth under different parents are
 * cousins, not siblings.
 */
function sameParentSibling(
  flat: FlatResource[],
  row: FlatResource,
  dir: -1 | 1,
): FlatResource | undefined {
  const index = flat.findIndex(({ item }) => item.id === row.item.id);
  if (index === -1) return undefined;
  for (let i = index + dir; i >= 0 && i < flat.length; i += dir) {
    const candidate = flat[i];
    if (
      candidate &&
      candidate.depth === row.depth &&
      candidate.parentId === row.parentId
    ) {
      return candidate;
    }
  }
  return undefined;
}

function flattenResources(
  items: SidebarResource[],
  expanded: Set<string>,
  depth = 0,
  parentId: string | null = null,
  visibleChildCount?: (item: SidebarResource) => number | undefined,
): FlatEntry[] {
  return items.flatMap((item) => {
    const entry: FlatEntry = { kind: "row", row: { item, depth, parentId } };
    if (!item.children?.length || !expanded.has(item.id)) return [entry];
    // 展开时按可见上限截断子节点；hidden > 0 则在子节点末尾追加「展开更多」行。
    const visible = visibleChildCount?.(item);
    const children =
      visible === undefined ? item.children : item.children.slice(0, visible);
    const childEntries = flattenResources(
      children,
      expanded,
      depth + 1,
      item.id,
      visibleChildCount,
    );
    const hidden = item.children.length - children.length;
    if (hidden <= 0) return [entry, ...childEntries];
    const more: FlatMoreRow = {
      kind: "more",
      parentId: item.id,
      depth: depth + 1,
      hiddenCount: hidden,
    };
    return [entry, ...childEntries, more];
  });
}

function findResource(
  items: SidebarResource[],
  id: string,
): SidebarResource | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children ? findResource(item.children, id) : undefined;
    if (child) return child;
  }
}

function containsResource(item: SidebarResource, id: string): boolean {
  return (
    item.id === id ||
    item.children?.some((child) => containsResource(child, id)) === true
  );
}

function removeResource(
  items: SidebarResource[],
  id: string,
): { items: SidebarResource[]; removed?: SidebarResource } {
  let removed: SidebarResource | undefined;
  const next: SidebarResource[] = [];

  for (const item of items) {
    if (item.id === id) {
      removed = item;
      continue;
    }

    if (item.children?.length) {
      const childResult = removeResource(item.children, id);
      if (childResult.removed) {
        removed = childResult.removed;
        next.push({ ...item, children: childResult.items });
        continue;
      }
    }

    next.push(item);
  }

  return { items: next, removed };
}

function insertResource(
  items: SidebarResource[],
  resource: SidebarResource,
  targetId: string | null,
  position: SidebarResourceDropPosition,
): SidebarResource[] {
  if (targetId === null) return [...items, resource];

  const next: SidebarResource[] = [];
  for (const item of items) {
    if (item.id === targetId) {
      if (position === "before") next.push(resource, item);
      else if (position === "after") next.push(item, resource);
      else next.push({ ...item, children: [...(item.children ?? []), resource] });
      continue;
    }

    if (item.children?.length) {
      next.push({
        ...item,
        children: insertResource(item.children, resource, targetId, position),
      });
    } else {
      next.push(item);
    }
  }
  return next;
}

function moveResource(
  items: SidebarResource[],
  move: SidebarResourceMove,
): SidebarResource[] | null {
  const source = findResource(items, move.itemId);
  if (!source || source.disabled) return null;
  if (move.targetId && containsResource(source, move.targetId)) return null;

  const target = move.targetId ? findResource(items, move.targetId) : undefined;
  if (
    move.position === "inside" &&
    (!target || target.disabled || !canContain(target))
  )
    return null;

  const removed = removeResource(items, move.itemId);
  if (!removed.removed) return null;
  return insertResource(
    removed.items,
    removed.removed,
    move.targetId,
    move.position,
  );
}

function renameResource(
  items: SidebarResource[],
  id: string,
  label: string,
): SidebarResource[] {
  return items.map((item) => ({
    ...item,
    label: item.id === id ? label : item.label,
    children: item.children
      ? renameResource(item.children, id, label)
      : undefined,
  }));
}

function defaultIcon(item: SidebarResource, expanded: boolean) {
  const Icon =
    item.kind === "folder" || item.kind === "project"
      ? expanded
        ? FolderOpen
        : Folder
      : item.kind === "bookmark"
          ? Bookmark
          : FileText;
  return <Icon className="size-4" />;
}

function MarqueeLabel({ active, children }: { active: boolean; children: string }) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const label = labelRef.current;
      if (!viewport || !label) return;
      setDistance(label.scrollWidth > viewport.clientWidth ? label.scrollWidth + 24 : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (labelRef.current) observer.observe(labelRef.current);
    return () => observer.disconnect();
  }, []);

  const running = active && distance > 0 && !reduce;

  return (
    <span ref={viewportRef} className="block min-w-0 flex-1 overflow-hidden">
      <motion.span
        className="flex w-max items-center gap-6 whitespace-nowrap"
        animate={{ x: running ? [0, -distance] : 0 }}
        transition={
          running
            ? {
                duration: Math.max(2.4, distance / 34),
                ease: "linear",
                repeat: Number.POSITIVE_INFINITY,
                repeatDelay: 2,
              }
            : ROW_REVEAL
        }
      >
        <span ref={labelRef}>{children}</span>
        {running ? <span aria-hidden="true">{children}</span> : null}
      </motion.span>
    </span>
  );
}

function ResourceMenuAction({
  icon: Icon,
  onSelect,
  children,
}: {
  icon: LucideIcon;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

interface ResourceRowProps {
  row: FlatResource;
  active: boolean;
  expanded: boolean;
  focused: boolean;
  draggingId: string | null;
  dropTarget: DropTarget | null;
  menuOpen: boolean;
  moves: SidebarResourceMoveCommands;
  renaming: boolean;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>, row: FlatResource) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, id: string) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onMenuOpenChange: (open: boolean) => void;
  onRenameCancel: () => void;
  onRenameCommit: (label: string) => void;
  onRenameStart: () => void;
  onSelect: () => void;
  onToggle: () => void;
  renderIcon?: (item: SidebarResource) => ReactNode;
  renderMenu?: AISidebarProps["renderMenu"];
  trailingAction?: ReactNode;
  setRef: (node: HTMLDivElement | null) => void;
}

function ResourceRow({
  row,
  active,
  expanded,
  focused,
  draggingId,
  dropTarget,
  menuOpen,
  moves,
  renaming,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onFocus,
  onKeyDown,
  onMenuOpenChange,
  onRenameCancel,
  onRenameCommit,
  onRenameStart,
  onSelect,
  onToggle,
  renderIcon,
  renderMenu,
  trailingAction,
  setRef,
}: ResourceRowProps) {
  const reduce = useReducedMotion() ?? false;
  const canTouch = useTouchCapable();
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipRenameBlurRef = useRef(false);
  const draggedRef = useRef(false);
  const [draft, setDraft] = useState(row.item.label);
  const acceptsChildren = canContain(row.item);
  const isDragging = draggingId === row.item.id;
  const dropPosition = dropTarget?.id === row.item.id ? dropTarget.position : null;

  useEffect(() => {
    if (!renaming) return;
    skipRenameBlurRef.current = false;
    setDraft(row.item.label);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [renaming, row.item.label]);

  const runFromMenu = (action: () => void) => () => {
    onMenuOpenChange(false);
    action();
  };

  const menu = renderMenu?.(row.item, {
    close: () => onMenuOpenChange(false),
    rename: () => {
      onMenuOpenChange(false);
      onRenameStart();
    },
    moves,
  }) ?? (
    <>
      <ResourceMenuAction icon={Pencil} onSelect={runFromMenu(onRenameStart)}>
        Rename
      </ResourceMenuAction>
      {moves.up || moves.down || moves.into || moves.out ? (
        <div aria-hidden="true" className="my-1 h-px bg-border" />
      ) : null}
      {moves.up ? (
        <ResourceMenuAction icon={ArrowUp} onSelect={runFromMenu(moves.up)}>
          Move up
        </ResourceMenuAction>
      ) : null}
      {moves.down ? (
        <ResourceMenuAction icon={ArrowDown} onSelect={runFromMenu(moves.down)}>
          Move down
        </ResourceMenuAction>
      ) : null}
      {moves.into ? (
        <ResourceMenuAction
          icon={FolderInput}
          onSelect={runFromMenu(moves.into.run)}
        >
          Move into {moves.into.label}
        </ResourceMenuAction>
      ) : null}
      {moves.out ? (
        <ResourceMenuAction icon={Undo2} onSelect={runFromMenu(moves.out)}>
          Move out
        </ResourceMenuAction>
      ) : null}
    </>
  );

  return (
    <motion.div
      ref={setRef}
      layout="position"
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={acceptsChildren ? undefined : active}
      aria-expanded={acceptsChildren ? expanded : undefined}
      aria-disabled={row.item.disabled || undefined}
      tabIndex={focused ? 0 : -1}
      draggable={!row.item.disabled && !renaming}
      data-menu-open={menuOpen || undefined}
      data-drop={dropPosition ?? undefined}
      data-dragging={isDragging || undefined}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          draggedRef.current ||
          renaming ||
          row.item.disabled
        )
          return;
        // A click inside the row's ⋯ menu must not toggle/select the row —
        // menu actions (rename / move / remove) bubble up here and would flip
        // a container's expand/collapse or re-select the row mid-action.
        if ((event.target as HTMLElement).closest?.("[data-sidebar-resource-menu]"))
          return;
        if (acceptsChildren) onToggle();
        else onSelect();
      }}
      onDoubleClick={(event) => {
        if (acceptsChildren || row.item.disabled) return;
        event.preventDefault();
        onRenameStart();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragStartCapture={(event) => {
        draggedRef.current = true;
        onDragStart(event, row.item.id);
      }}
      onDragEndCapture={() => {
        onDragEnd();
        requestAnimationFrame(() => {
          draggedRef.current = false;
        });
      }}
      onDragOver={(event) => onDragOver(event, row)}
      onDrop={onDrop}
      className={cn(
        "group/resource relative flex min-h-9 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 text-sm outline-none",
        "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        "focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        "data-[menu-open=true]:bg-muted data-[menu-open=true]:text-foreground",
        "data-[dragging=true]:opacity-40",
        "data-[drop=inside]:bg-primary/10 data-[drop=inside]:ring-1 data-[drop=inside]:ring-primary/45",
        "data-[drop=before]:before:absolute data-[drop=before]:before:-top-0.5 data-[drop=before]:before:right-2 data-[drop=before]:before:left-2 data-[drop=before]:before:h-0.5 data-[drop=before]:before:rounded-full data-[drop=before]:before:bg-primary",
        "data-[drop=after]:after:absolute data-[drop=after]:after:-bottom-0.5 data-[drop=after]:after:right-2 data-[drop=after]:after:left-2 data-[drop=after]:after:h-0.5 data-[drop=after]:after:rounded-full data-[drop=after]:after:bg-primary",
        !acceptsChildren && active && "bg-muted text-foreground",
        row.item.disabled && "cursor-not-allowed opacity-45",
      )}
      style={{ paddingLeft: `${12 + row.depth * 16}px` }}
    >
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
        {renderIcon?.(row.item) ?? defaultIcon(row.item, expanded)}
      </span>

      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label={`Rename ${row.item.label}`}
          onChange={(event) => setDraft(event.target.value)}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onBlur={() => {
            if (!skipRenameBlurRef.current) onRenameCommit(draft);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              skipRenameBlurRef.current = true;
              onRenameCommit(draft);
            }
            if (event.key === "Escape") {
              skipRenameBlurRef.current = true;
              onRenameCancel();
            }
          }}
          className="mx-1 h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <MarqueeLabel active={hovered || menuOpen}>{row.item.label}</MarqueeLabel>
      )}

      {!renaming && !row.item.disabled ? (
        // ⋯ 与行尾动作位同容器：间距 gap-0.5 对齐「项目」分区头的 ⋯/+ 组；
        // 弹层内容 portal 到 body，包裹触发器不影响定位。
        <div className="flex shrink-0 items-center gap-0.5">
          <MorphPopover
            open={menuOpen}
            onOpenChange={onMenuOpenChange}
          >
            <MorphPopoverTrigger>
              <button
                type="button"
                draggable={false}
                tabIndex={-1}
                aria-label={`Actions for ${row.item.label}`}
                onClick={(event) => event.stopPropagation()}
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-lg outline-none transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100",
                  // A finger never hovers, and this menu is the only path to
                  // rename and move without a drag — keep it on screen there.
                  canTouch ? "opacity-100" : "opacity-0",
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
              className="w-40 p-1.5"
            >
              <div data-sidebar-resource-menu={row.item.id}>{menu}</div>
            </MorphPopoverContent>
          </MorphPopover>
          {trailingAction}
        </div>
      ) : null}
    </motion.div>
  );
}

/**
 * 「展开更多」行：缩进与子节点对齐，点击后当前容器再展示一批子节点。
 * 不参与 roving tabindex / 拖拽，仅是一颗普通按钮。
 */
function ShowMoreRow({
  depth,
  hiddenCount,
  label,
  onShowMore,
}: {
  depth: number;
  hiddenCount: number;
  label: string;
  onShowMore: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      layout="position"
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
    >
      <button
        type="button"
        onClick={onShowMore}
        aria-label={`${label}（还有 ${hiddenCount} 个未显示）`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        className={cn(
          "flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 text-sm outline-none",
          "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          "focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        <span
          aria-hidden="true"
          className="grid size-5 shrink-0 place-items-center"
        >
          <ChevronDown className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-muted-foreground/70 tabular-nums"
        >
          {hiddenCount}
        </span>
      </button>
    </motion.div>
  );
}

export function AISidebar({
  items,
  defaultItems = [],
  onItemsChange,
  onMove,
  onMoveError,
  onRename,
  activeId,
  defaultActiveId = null,
  onActiveChange,
  defaultExpandedIds = [],
  expandedIds: expandedIdsProp,
  onExpandedChange,
  visibleChildren,
  showMoreLabel = "展开更多",
  renderIcon,
  renderMenu,
  renderTrailingAction,
  ariaLabel = "Resources",
  className,
}: AISidebarProps) {
  const [internalItems, setInternalItems] = useState(items ?? defaultItems);
  const [internalActiveId, setInternalActiveId] = useState(defaultActiveId);
  const [internalExpandedIds, setInternalExpandedIds] = useState(
    () => new Set(defaultExpandedIds),
  );
  // 受控/非受控双模式：传入 expandedIds 时由外部驱动展开集合，
  // 便于宿主实现「全部展开 / 全部折叠」。
  const expandedIds = expandedIdsProp ?? internalExpandedIds;
  const setExpandedIds = useCallback(
    (updater: (current: Set<string>) => Set<string>) => {
      if (expandedIdsProp && onExpandedChange) {
        onExpandedChange(updater(expandedIdsProp));
      } else {
        setInternalExpandedIds(updater);
      }
    },
    [expandedIdsProp, onExpandedChange],
  );
  // 每个容器的「展开更多」进度（已额外展开的批次数）。
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  const [focusedId, setFocusedId] = useState<string | null>(
    activeId ?? defaultActiveId,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Refs mirror the live drag target so `drop`/`dragover` read the freshest
  // value instead of the render's closure — otherwise a quick release lands on
  // a stale (often null) target and the drop is silently dropped.
  const draggingIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const setDrag = useCallback((id: string | null) => {
    draggingIdRef.current = id;
    setDraggingId(id);
  }, []);
  const setTarget = useCallback((target: DropTarget | null) => {
    dropTargetRef.current = target;
    setDropTarget(target);
  }, []);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const movePendingRef = useRef(false);
  // Tracks top-level ids we've ever seen, so a newly added project is
  // auto-expanded on first appearance without re-expanding ones the user
  // deliberately collapsed (those are already in the seen set).
  const seenTopIdsRef = useRef<Set<string> | null>(null);
  const renderedItems = internalItems;
  const selectedId = activeId ?? internalActiveId;

  useEffect(() => {
    if (!items) return;
    setInternalItems(items);
    if (!seenTopIdsRef.current) {
      seenTopIdsRef.current = new Set(items.map((it) => it.id));
      return;
    }
    const newIds = items
      .map((it) => it.id)
      .filter((id) => !seenTopIdsRef.current!.has(id));
    if (newIds.length) {
      seenTopIdsRef.current = new Set([...seenTopIdsRef.current, ...newIds]);
      setExpandedIds((cur) => new Set([...cur, ...newIds]));
    }
  }, [items, setExpandedIds]);

  // 折叠的容器重置「展开更多」进度：重新展开时只显示第一批（有限个）子项。
  // 用 effect 对比前后展开集合，覆盖 toggle 与受控折叠（如「全部折叠」）两条路径。
  const prevExpandedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prev = prevExpandedRef.current;
    prevExpandedRef.current = expandedIds;
    if (!prev) return;
    const collapsed = [...prev].filter((id) => !expandedIds.has(id));
    if (!collapsed.length) return;
    setRevealed((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of collapsed) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [expandedIds]);

  // 容器被移除后清掉残留的展开进度，重新添加时从头计数。
  useEffect(() => {
    setRevealed((current) => {
      const live = new Set(renderedItems.map((it) => it.id));
      const stale = Object.keys(current).filter((id) => !live.has(id));
      if (!stale.length) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [renderedItems]);

  // 可见子节点数：批次 × (1 + 已展开批次数)，夹在子节点总数内；
  // 无隐藏子节点时返回 undefined（不截断、无「展开更多」行）。
  const visibleChildCount = useCallback(
    (item: SidebarResource): number | undefined => {
      if (!item.children?.length) return undefined;
      const batch =
        typeof visibleChildren === "function"
          ? visibleChildren(item)
          : visibleChildren;
      if (!batch || batch < 1) return undefined;
      const shown = Math.min(
        batch * (1 + (revealed[item.id] ?? 0)),
        item.children.length,
      );
      return shown >= item.children.length ? undefined : shown;
    },
    [revealed, visibleChildren],
  );

  const renderList = useMemo(
    () =>
      flattenResources(renderedItems, expandedIds, 0, null, visibleChildCount),
    [expandedIds, renderedItems, visibleChildCount],
  );

  // 键盘导航 / 拖拽只关心资源行；「展开更多」行只参与渲染。
  const flat = useMemo(
    () =>
      renderList.flatMap((entry) => (entry.kind === "row" ? [entry.row] : [])),
    [renderList],
  );

  // Which row carries the roving tabindex is resolved during render, never in
  // a passive effect: an effect lands after the browser paints, so the first
  // commit — and, on a server-rendered page, the markup itself — would have no
  // tabbable row and Tab would skip the whole tree. The same hole opens again
  // whenever a collapse or a rolled-back move takes the focused row out of it.
  const focusedRow =
    focusedId !== null && flat.some((row) => row.item.id === focusedId)
      ? focusedId
      : (flat[0]?.item.id ?? null);
  if (focusedId !== focusedRow) setFocusedId(focusedRow);

  useEffect(() => {
    if (!menuOpenId) return;
    const frame = requestAnimationFrame(() => {
      const menus = Array.from(
        document.querySelectorAll<HTMLElement>("[data-sidebar-resource-menu]"),
      );
      menus
        .find((menu) => menu.dataset.sidebarResourceMenu === menuOpenId)
        ?.querySelector<HTMLElement>("button, a[href]")
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpenId]);

  // 激活行变化（如新建会话后列表末尾新增）时滚入视野；
  // block: nearest —— 已在可视区内则不动，只有视野外才滚动。
  useEffect(() => {
    if (!selectedId) return;
    const frame = requestAnimationFrame(() => {
      rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId]);

  const updateItems = useCallback(
    (next: SidebarResource[]) => {
      setInternalItems(next);
      onItemsChange?.(next);
    },
    [onItemsChange],
  );

  const performMove = useCallback(
    async (move: SidebarResourceMove) => {
      if (movePendingRef.current) {
        setAnnouncement("Wait for the current move to finish.");
        return;
      }
      const before = renderedItems;
      const next = moveResource(before, move);
      if (!next || next === before) return;

      movePendingRef.current = true;
      updateItems(next);
      setTarget(null);
      setDrag(null);
      const moved = findResource(before, move.itemId);
      const target = move.targetId ? findResource(before, move.targetId) : null;
      setAnnouncement(
        target
          ? `Moved ${moved?.label ?? "item"} ${move.position} ${target.label}.`
          : `Moved ${moved?.label ?? "item"} to the top level.`,
      );

      try {
        await onMove?.(move);
      } catch (error) {
        updateItems(before);
        setAnnouncement(`Move failed. ${moved?.label ?? "Item"} was restored.`);
        onMoveError?.(error, move);
      } finally {
        movePendingRef.current = false;
      }
    },
    [onMove, onMoveError, renderedItems, updateItems, setTarget, setDrag],
  );

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);

  const select = useCallback(
    (id: string) => {
      if (activeId === undefined) setInternalActiveId(id);
      onActiveChange?.(id);
    },
    [activeId, onActiveChange],
  );

  const toggle = useCallback(
    (id: string) => {
      setExpandedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setExpandedIds],
  );

  // 「展开更多」：当前容器再展示一批子节点，并播报剩余数量。
  const revealMore = useCallback(
    (more: { parentId: string; hiddenCount: number }) => {
      const parent = findResource(renderedItems, more.parentId);
      const batch = parent
        ? typeof visibleChildren === "function"
          ? visibleChildren(parent)
          : visibleChildren
        : undefined;
      const step =
        batch && batch > 0 ? Math.min(batch, more.hiddenCount) : more.hiddenCount;
      setRevealed((current) => ({
        ...current,
        [more.parentId]: (current[more.parentId] ?? 0) + 1,
      }));
      const remaining = more.hiddenCount - step;
      setAnnouncement(
        parent
          ? remaining > 0
            ? `已展开 ${parent.label} 的 ${step} 个子项，还有 ${remaining} 个未显示。`
            : `已展开 ${parent.label} 的全部子项。`
          : "已展开更多子项。",
      );
    },
    [renderedItems, visibleChildren],
  );

  // The same four moves `Alt+Shift+Arrow` performs, handed to the row menu so
  // they survive on a device with no drag and no modifier keys.
  const moveCommands = useCallback(
    (row: FlatResource): SidebarResourceMoveCommands => {
      if (row.item.disabled) return {};
      const index = flat.findIndex(({ item }) => item.id === row.item.id);
      const previous = flat[index - 1];
      const parentId = row.parentId;
      // up/down must target the same-level sibling, not the raw adjacent row
      // (which may be this row's own child when expanded, or a cousin), else the
      // move would nest or silently no-op.
      const prevSibling = sameParentSibling(flat, row, -1);
      const nextSibling = sameParentSibling(flat, row, 1);
      const commands: SidebarResourceMoveCommands = {};

      if (prevSibling) {
        commands.up = () =>
          void performMove({
            itemId: row.item.id,
            targetId: prevSibling.item.id,
            position: "before",
          });
      }
      if (nextSibling) {
        commands.down = () =>
          void performMove({
            itemId: row.item.id,
            targetId: nextSibling.item.id,
            position: "after",
          });
      }
      // Only offer the reparent when it lands somewhere new — the row above a
      // folder's first child is the folder it already lives in.
      if (previous && canContain(previous.item) && previous.item.id !== parentId) {
        commands.into = {
          label: previous.item.label,
          run: () => {
            setExpandedIds((current) => new Set(current).add(previous.item.id));
            void performMove({
              itemId: row.item.id,
              targetId: previous.item.id,
              position: "inside",
            });
          },
        };
      }
      if (parentId) {
        commands.out = () =>
          void performMove({
            itemId: row.item.id,
            targetId: parentId,
            position: "after",
          });
      }

      return commands;
    },
    [flat, performMove, setExpandedIds],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: FlatResource) => {
      const index = flat.findIndex(({ item }) => item.id === row.item.id);
      const previous = flat[index - 1];
      const next = flat[index + 1];
      const prevSibling = sameParentSibling(flat, row, -1);
      const nextSibling = sameParentSibling(flat, row, 1);
      const moveModifier = event.altKey && event.shiftKey;

      if (event.key === "ArrowDown" && !moveModifier && next) {
        event.preventDefault();
        focusRow(next.item.id);
        return;
      }
      if (event.key === "ArrowUp" && !moveModifier && previous) {
        event.preventDefault();
        focusRow(previous.item.id);
        return;
      }
      if (event.key === "Home" && flat[0]) {
        event.preventDefault();
        focusRow(flat[0].item.id);
        return;
      }
      if (event.key === "End" && flat.at(-1)) {
        event.preventDefault();
        focusRow(flat.at(-1)?.item.id ?? row.item.id);
        return;
      }

      if (row.item.disabled) {
        if (event.key === "ArrowLeft" && row.parentId) {
          event.preventDefault();
          focusRow(row.parentId);
        } else if (
          moveModifier ||
          ["ArrowRight", "Enter", " ", "F2", "ContextMenu"].includes(
            event.key,
          ) ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
        }
        return;
      }

      if (moveModifier && event.key === "ArrowUp" && prevSibling) {
        event.preventDefault();
        void performMove({ itemId: row.item.id, targetId: prevSibling.item.id, position: "before" });
        return;
      }
      if (moveModifier && event.key === "ArrowDown" && nextSibling) {
        event.preventDefault();
        void performMove({ itemId: row.item.id, targetId: nextSibling.item.id, position: "after" });
        return;
      }
      if (moveModifier && event.key === "ArrowRight" && previous && canContain(previous.item)) {
        event.preventDefault();
        setExpandedIds((current) => new Set(current).add(previous.item.id));
        void performMove({ itemId: row.item.id, targetId: previous.item.id, position: "inside" });
        return;
      }
      if (moveModifier && event.key === "ArrowLeft" && row.parentId) {
        event.preventDefault();
        void performMove({ itemId: row.item.id, targetId: row.parentId, position: "after" });
        return;
      }

      if (event.key === "ArrowRight" && canContain(row.item)) {
        event.preventDefault();
        if (!expandedIds.has(row.item.id)) toggle(row.item.id);
        else if (next?.parentId === row.item.id) focusRow(next.item.id);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (expandedIds.has(row.item.id)) toggle(row.item.id);
        else if (row.parentId) focusRow(row.parentId);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (canContain(row.item)) toggle(row.item.id);
        else select(row.item.id);
      } else if (event.key === "F2") {
        event.preventDefault();
        setRenamingId(row.item.id);
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        setMenuOpenId(row.item.id);
      }
    },
    [expandedIds, flat, focusRow, performMove, select, setExpandedIds, toggle],
  );

  return (
    <>
      <div
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable="false"
      onDragOver={(event) => {
        if (!draggingIdRef.current || event.target !== event.currentTarget) return;
        event.preventDefault();
        setTarget({ id: null, position: "after" });
      }}
      onDrop={(event) => {
        event.preventDefault();
        const did = draggingIdRef.current;
        const target = dropTargetRef.current;
        if (did && target) {
          void performMove({
            itemId: did,
            targetId: target.id,
            position: target.position,
          });
        }
      }}
      className={cn(
        "relative flex min-w-0 flex-col gap-0.5 [overflow-anchor:none] group-data-[state=collapsed]/sidebar:hidden",
        draggingId && "select-none pb-9",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {renderList.map((entry) =>
          entry.kind === "row" ? (
            <ResourceRow
              key={entry.row.item.id}
              row={entry.row}
              active={selectedId === entry.row.item.id}
              expanded={expandedIds.has(entry.row.item.id)}
              focused={focusedRow === entry.row.item.id}
              draggingId={draggingId}
              dropTarget={dropTarget}
              menuOpen={menuOpenId === entry.row.item.id}
              moves={moveCommands(entry.row)}
              renaming={renamingId === entry.row.item.id}
              onFocus={() => setFocusedId(entry.row.item.id)}
              onSelect={() => select(entry.row.item.id)}
              onToggle={() => toggle(entry.row.item.id)}
              onKeyDown={(event) => handleKeyDown(event, entry.row)}
              onRenameStart={() => setRenamingId(entry.row.item.id)}
              onRenameCancel={() => setRenamingId(null)}
              onRenameCommit={(label) => {
                const trimmed = label.trim();
                setRenamingId(null);
                if (!trimmed || trimmed === entry.row.item.label) return;
                const before = renderedItems;
                updateItems(renameResource(before, entry.row.item.id, trimmed));
                void Promise.resolve(onRename?.(entry.row.item, trimmed)).catch(() => {
                  updateItems(before);
                  setAnnouncement(`Rename failed. ${entry.row.item.label} was restored.`);
                });
              }}
              onMenuOpenChange={(open) => {
                setMenuOpenId(open ? entry.row.item.id : null);
                if (!open) focusRow(entry.row.item.id);
              }}
              onDragStart={(event, id) => {
                setDrag(id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", id);
              }}
              onDragEnd={() => {
                setDrag(null);
                setTarget(null);
              }}
              onDragOver={(event, targetRow) => {
                const did = draggingIdRef.current;
                if (!did || did === targetRow.item.id) return;
                const source = findResource(renderedItems, did);
                if (source && containsResource(source, targetRow.item.id)) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - rect.top) / rect.height;
                const position =
                  !targetRow.item.disabled &&
                  canContain(targetRow.item) &&
                  ratio >= 0.25 &&
                  ratio <= 0.75
                    ? "inside"
                    : ratio < 0.5
                      ? "before"
                      : "after";
                setTarget({ id: targetRow.item.id, position });
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const did = draggingIdRef.current;
                const target = dropTargetRef.current;
                if (did && target) {
                  void performMove({
                    itemId: did,
                    targetId: target.id,
                    position: target.position,
                  });
                }
              }}
              renderIcon={renderIcon}
              renderMenu={renderMenu}
              trailingAction={renderTrailingAction?.(entry.row.item)}
              setRef={(node) => {
                if (node) rowRefs.current.set(entry.row.item.id, node);
                else rowRefs.current.delete(entry.row.item.id);
              }}
            />
          ) : (
            <ShowMoreRow
              key={`more:${entry.parentId}`}
              depth={entry.depth}
              hiddenCount={entry.hiddenCount}
              label={showMoreLabel}
              onShowMore={() => revealMore(entry)}
            />
          ),
        )}
      </AnimatePresence>

      {draggingId ? (
        <div
          aria-hidden="true"
          data-active={dropTarget?.id === null || undefined}
          className="absolute inset-x-1 bottom-0 flex h-8 items-center justify-center rounded-lg border border-dashed border-border text-[10px] text-muted-foreground data-[active=true]:border-primary/50 data-[active=true]:bg-primary/10 data-[active=true]:text-foreground"
        >
          Move to top level
        </div>
      ) : null}

      </div>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
