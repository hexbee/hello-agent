"use client";
// beui.dev/components/agents/code-block

import {
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  LoaderCircle,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type AgentCodeLanguage,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@/components/agents/agent-code";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type CodeBlockStatus = "streaming" | "complete";

export interface CodeBlockProps {
  code: string;
  language?: AgentCodeLanguage;
  filename?: ReactNode;
  status?: CodeBlockStatus;
  defaultOpen?: boolean;
  showLineNumbers?: boolean;
  highlightLines?: number[];
  maxHeight?: number;
  wrap?: boolean;
  copyable?: boolean;
  onCopy?: () => void | Promise<void>;
  className?: string;
}

export function CodeBlock({
  code,
  language = "typescript",
  filename,
  status = "complete",
  defaultOpen = true,
  showLineNumbers = true,
  highlightLines = [],
  maxHeight = 280,
  wrap = false,
  copyable = true,
  onCopy,
  className,
}: CodeBlockProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = internalOpen;
  const streaming = status === "streaming";
  const tokens = useAgentCodeTokens(code, language);
  const canCopy = copyable && Boolean(code);

  const setOpen = useCallback((next: boolean) => {
    setInternalOpen(next);
  }, []);

  // 流式写入时跟随新行；完成后自动折叠（与 ToolResult/FileDiff 一致）。
  useEffect(() => {
    if (previousStatus.current === "streaming" && status === "complete") {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [setOpen, status]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !currentOpen || !streaming) return;

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: reduce ? "auto" : "smooth",
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else await navigator.clipboard?.writeText(code);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [code, onCopy]);

  const lines = code.split("\n");
  const highlighted = new Set(highlightLines);

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cn("w-full text-sm", className)}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <FileCode2
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
          {filename}
        </span>
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground/60">
          {streaming ? (
            <LoaderCircle
              aria-label="Writing file"
              className={cn("size-3.5", !reduce && "animate-spin")}
            />
          ) : (
            <Check aria-label="File written" className="size-3.5" />
          )}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure
        id={contentId}
        role="region"
        aria-labelledby={triggerId}
        open={currentOpen}
      >
        <div className="pl-6 pt-1.5">
          <div className="overflow-hidden rounded-xl bg-muted/80">
            <div
              ref={viewportRef}
              data-slot="code-block-viewport"
              aria-live="polite"
              className="scrollbar-hide overflow-auto"
              style={{ maxHeight }}
            >
              <div className="font-mono text-xs leading-5">
                <span className="sr-only">File content</span>
                {lines.map((line, index) => (
                  <div
                    key={index}
                    className={cn(
                      "grid",
                      showLineNumbers
                        ? "grid-cols-[2.25rem_minmax(0,1fr)]"
                        : "grid-cols-[minmax(0,1fr)]",
                      highlighted.has(index + 1) &&
                        "bg-accent/[0.12] dark:bg-accent/[0.2]",
                    )}
                  >
                    {showLineNumbers ? (
                      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">
                        {index + 1}
                      </span>
                    ) : null}
                    <AgentCodeLine
                      code={line}
                      tokens={tokens?.[index]}
                      className={cn(
                        "min-w-0 px-1.5",
                        wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
                      )}
                    />
                  </div>
                ))}
              </div>
            </div>

            {canCopy ? (
              <div className="flex justify-end px-2 pb-1.5 pt-1">
                <motion.button
                  type="button"
                  aria-label={copied ? "Copied" : "Copy code"}
                  title={copied ? "Copied" : "Copy code"}
                  onClick={handleCopy}
                  whileTap={reduce ? undefined : { scale: 0.9 }}
                  transition={SPRING_PRESS}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </motion.button>
              </div>
            ) : null}
          </div>
        </div>
      </AgentDisclosure>
    </div>
  );
}
