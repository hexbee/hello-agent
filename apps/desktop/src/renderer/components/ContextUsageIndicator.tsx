import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextUsage } from "@hello-agent/shared";
import { usePopoverPortalPosition } from "./motion/popover-position";

const formatTokens = (tokens: number) => new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
}).format(tokens).toLowerCase();

export function ContextUsageIndicator({ usage }: { usage: ContextUsage | null }) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const layout = usePopoverPortalPosition(triggerRef, contentRef, open);
  const known = usage?.tokens != null && usage.percent != null;
  const percent = known ? Math.max(0, Math.round(usage.percent!)) : null;
  const fill = Math.min(100, percent ?? 0);
  const summary = percent === null
    ? "上下文用量等待更新"
    : `上下文已用 ${percent}%，剩余 ${Math.max(0, 100 - percent)}%`;

  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={summary}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={show}
        className="grid size-8 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4.5 -rotate-90" fill="none">
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
          {fill > 0 ? (
            <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.5"
              pathLength="100" strokeDasharray={`${fill} 100`} strokeLinecap="round" />
          ) : null}
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={contentRef}
          id={id}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hide}
          className="fixed z-[100] w-64 max-w-[calc(100vw-16px)] rounded-2xl border border-border bg-background px-3.5 py-2.5 text-center text-sm text-foreground shadow-lg"
          style={{
            visibility: layout ? "visible" : "hidden",
            left: layout ? Math.max(8, Math.min(
              layout.trigger.left + layout.trigger.width / 2 - layout.content.width / 2,
              window.innerWidth - layout.content.width - 8,
            )) : 0,
            top: layout ? (layout.trigger.top >= layout.content.height + 16
              ? layout.trigger.top - layout.content.height - 8
              : layout.trigger.top + layout.trigger.height + 8) : 0,
          }}
        >
          <div className="mb-1 text-muted-foreground">上下文窗口</div>
          {percent !== null && usage ? (
            <>
              <div>{percent}% 已用（剩余 {Math.max(0, 100 - percent)}%）</div>
              <div>已用约 {formatTokens(usage.tokens!)} tokens，共 {formatTokens(usage.contextWindow)}</div>
              <div className="mt-1 text-xs text-muted-foreground">基于最近用量与后续消息估算</div>
            </>
          ) : (
            <>
              <div>用量等待更新</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {usage ? `窗口共 ${formatTokens(usage.contextWindow)} tokens，下一次模型响应后更新` : "选择模型后显示上下文用量"}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
