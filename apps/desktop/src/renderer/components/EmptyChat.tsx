import { BookOpen, FolderTree, GitBranch, Search } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "@/lib/ease";
import { store, useStore } from "../store";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

const SUGGESTIONS = [
  {
    id: "intro",
    label: "介绍这个项目",
    prompt: "介绍这个项目：它是做什么的，目录怎么组织，我该从哪看起。",
    icon: BookOpen,
  },
  {
    id: "tree",
    label: "查看目录结构",
    prompt: "列出当前工作区的目录结构，标出关键文件和它们的作用。",
    icon: FolderTree,
  },
  {
    id: "git",
    label: "最近改了什么",
    prompt: "用 git 看最近的提交和未提交改动，总结现在做到哪了。",
    icon: GitBranch,
  },
  {
    id: "improve",
    label: "找一个改进点",
    prompt: "浏览代码，指出一个值得先看的问题或改进点。",
    icon: Search,
  },
] as const;

export function EmptyChat() {
  const s = useStore();
  const reduce = useReducedMotion() ?? false;
  const disabled = s.trust === "untrusted" || s.agentState === "running";
  const project = s.cwd ? basename(s.cwd) : "";

  const enter = reduce
    ? { hidden: { opacity: 1 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 8 },
        show: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.4, ease: EASE_OUT },
        },
      };

  return (
    <motion.section
      aria-label="新对话"
      className="w-full"
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: reduce ? 0 : 0.07 } },
      }}
    >
      <motion.div variants={enter} className="text-center">
        <h1 className="text-[1.7rem] font-medium tracking-tight text-fg">
          {project ? (
            <span className="font-mono">{project}</span>
          ) : (
            "还没有打开项目"
          )}
        </h1>
        <p className="mx-auto mt-2 max-w-[34ch] text-sm leading-relaxed text-muted-foreground">
          {project
            ? "描述你想做的事，agent 会在这个工作区内协助你。"
            : "从左侧选择一个目录，就可以开始对话。"}
        </p>
      </motion.div>

      {project ? (
        <motion.div
          variants={{
            hidden: {},
            show: {
              transition: {
                staggerChildren: reduce ? 0 : 0.05,
                delayChildren: reduce ? 0 : 0.04,
              },
            },
          }}
          className="mt-8 grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {SUGGESTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <motion.button
                key={item.id}
                type="button"
                disabled={disabled}
                variants={enter}
                whileTap={reduce || disabled ? undefined : { scale: 0.98 }}
                onClick={() => void store.prompt(item.prompt)}
                className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-panel px-3.5 py-2.5 text-left text-sm text-fg transition-colors hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span>{item.label}</span>
              </motion.button>
            );
          })}
        </motion.div>
      ) : null}
    </motion.section>
  );
}
