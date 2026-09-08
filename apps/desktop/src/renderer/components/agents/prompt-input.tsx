"use client";
// beui.dev/components/agents/prompt-input

import { ArrowUp, Check, Plus, Puzzle, Shield, Square } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import {
  Select,
  SelectContent,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
} from "@/components/motion/select";
import { SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface PromptModel {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** 分组标题（如 provider 名）；同 group 的选项渲染在同一分组下。 */
  group?: string;
}

export interface PromptMode {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptAction {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptInputProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onSubmit" | "children"
> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  skills?: Array<{ name: string; description: string; filePath: string }>;
  skillDiagnostics?: Array<{ message: string; path?: string }>;
  models?: PromptModel[];
  modelHint?: ReactNode;
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  /** 权限模式选择（如 默认权限 / 完全访问），弹层向上展开。 */
  modes?: PromptMode[];
  mode?: string;
  defaultMode?: string;
  onModeChange?: (mode: string) => void;
  onSubmit?: (value: string, model?: string) => void | Promise<void>;
  loading?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  trailingAction?: ReactNode;
  className?: string;
}

interface ModelSection {
  group?: string;
  options: PromptModel[];
}

/** 把模型按 group（provider）聚合成分段，保持原顺序；无 group 的归为无标题段。 */
function groupModels(models: PromptModel[]): ModelSection[] {
  const sections: ModelSection[] = [];
  const byGroup = new Map<string, ModelSection>();
  for (const option of models) {
    const key = option.group ?? "";
    let section = byGroup.get(key);
    if (!section) {
      section = { group: key || undefined, options: [] };
      byGroup.set(key, section);
      sections.push(section);
    }
    section.options.push(option);
  }
  return sections;
}

export function PromptInput({
  value,
  defaultValue = "",
  onValueChange,
  skills = [],
  skillDiagnostics = [],
  models = [],
  modelHint,
  model,
  defaultModel,
  onModelChange,
  actions = [],
  onAction,
  modes = [],
  mode,
  defaultMode,
  onModeChange,
  onSubmit,
  loading = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  trailingAction,
  className,
  disabled,
  placeholder = "Ask the agent to do something…",
  "aria-label": ariaLabel = "Prompt",
  onKeyDown,
  ...textareaProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalModel, setInternalModel] = useState(
    defaultModel ?? models[0]?.value,
  );
  const [internalMode, setInternalMode] = useState(
    defaultMode ?? modes[0]?.value,
  );
  const [actionsOpen, setActionsOpen] = useState(false);
  const [modesOpen, setModesOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const skillListId = useId();
  const [skillBrowseOpen, setSkillBrowseOpen] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillsDismissed, setSkillsDismissed] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const skillToken = /^\/(?:skill(?::[^\s]*)?|[^\s]*)$/.test(currentValue);
  const skillQuery = skillBrowseOpen ? "" : currentValue.replace(/^\/(?:skill:?)?/, "").toLowerCase();
  const matchingSkills = skills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(skillQuery),
  );
  const skillsOpen = inputFocused && (skillBrowseOpen || skillToken) && !skillsDismissed && !disabled && !loading;
  const activeSkillIndex = Math.min(skillIndex, Math.max(0, matchingSkills.length - 1));
  useEffect(() => {
    setSkillBrowseOpen(false);
    setSkillIndex(0);
    setSkillsDismissed(false);
  }, [currentValue]);
  useEffect(() => {
    if (skillsOpen) document.getElementById(`${skillListId}-${activeSkillIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [skillsOpen, activeSkillIndex, skillListId]);
  const currentModelValue = model ?? internalModel;
  const currentModeValue = mode ?? internalMode;
  const currentModel = models.find(
    (option) => option.value === currentModelValue,
  );
  const currentMode = modes.find((option) => option.value === currentModeValue);
  const canSubmit = Boolean(currentValue.trim()) && !disabled && !loading;

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const measurement = measurementRef.current;
    if (!textarea || !measurement || textarea.value !== currentValue) return;

    const lineHeight = 24;
    const nextHeight = Math.min(
      Math.max(measurement.scrollHeight, minRows * lineHeight),
      maxRows * lineHeight,
    );
    const height = `${nextHeight}px`;
    if (textarea.style.height !== height) textarea.style.height = height;
  }, [currentValue, maxRows, minRows]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeTextarea);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };

  const chooseSkill = (name: string) => {
    setValue(`/skill:${name} ${skillBrowseOpen && !skillToken ? currentValue : ""}`);
    setSkillBrowseOpen(false);
    setSkillsDismissed(true);
    textareaRef.current?.focus({ preventScroll: true });
  };

  const setModel = (next: string) => {
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const setMode = (next: string) => {
    if (mode === undefined) setInternalMode(next);
    onModeChange?.(next);
    setModesOpen(false);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = currentValue.trim();
    if (!prompt || disabled || loading) return;

    onSubmit?.(prompt, currentModelValue);
    if (value === undefined) setInternalValue("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (skillsOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSkillsDismissed(true);
        return;
      }
      if (matchingSkills.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setSkillIndex((activeSkillIndex + (event.key === "ArrowDown" ? 1 : -1) + matchingSkills.length) % matchingSkills.length);
        return;
      }
      if (matchingSkills.length && !event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        chooseSkill(matchingSkills[activeSkillIndex]!.name);
        return;
      }
    }
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={submit}
      className={cn(
        "relative w-full rounded-2xl border border-border/80 bg-background p-2 transition-colors focus-within:border-foreground/25",
        disabled && "opacity-60",
        className,
      )}
    >
      {skillsOpen && (
        <div onMouseDown={(event) => event.preventDefault()} className="absolute inset-x-0 bottom-full z-50 mb-2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <div className="flex justify-between border-b px-3 py-2 text-xs text-muted-foreground">
            <span>Skills · {matchingSkills.length}</span>
            <span>↑↓ 选择 · Enter / Tab 补全 · Esc 关闭</span>
          </div>
          <div id={skillListId} role="listbox" aria-label="选择 skill" className="max-h-64 overflow-y-auto p-1">
            {matchingSkills.length ? matchingSkills.map((skill, index) => (
              <button
                key={skill.name}
                id={`${skillListId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeSkillIndex}
                tabIndex={-1}
                title={skill.filePath}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSkillIndex(index)}
                onClick={() => chooseSkill(skill.name)}
                className={cn("block w-full rounded-lg px-3 py-2 text-left", index === activeSkillIndex && "bg-accent text-accent-foreground")}
              >
                <div className="text-sm font-medium">/skill:{skill.name}</div>
                <div className={cn("line-clamp-2 text-xs", index === activeSkillIndex ? "text-accent-foreground/85" : "text-muted-foreground")}>{skill.description}</div>
              </button>
            )) : <div className="px-3 py-4 text-sm text-muted-foreground">{skills.length ? "没有匹配的 skill" : "未发现可用的 skill"}</div>}
          </div>
          {skillDiagnostics.length > 0 && <details className="border-t px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{skillDiagnostics.length} 条加载提示</summary>
            {skillDiagnostics.map((diagnostic, index) => <p key={index} className="mt-2 break-all">{diagnostic.message}{diagnostic.path ? ` (${diagnostic.path})` : ""}</p>)}
          </details>}
        </div>
      )}
      <div
        ref={measurementRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-2 top-0 whitespace-pre-wrap px-2 text-sm leading-6 [overflow-wrap:break-word]"
      >
        {`${currentValue}\u200b`}
      </div>
      <textarea
        ref={textareaRef}
        value={currentValue}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={minRows}
        {...textareaProps}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={skillsOpen}
        aria-controls={skillsOpen ? skillListId : undefined}
        aria-activedescendant={skillsOpen && matchingSkills.length ? `${skillListId}-${activeSkillIndex}` : undefined}
        onFocus={(event) => { setInputFocused(true); textareaProps.onFocus?.(event); }}
        onBlur={(event) => { setInputFocused(false); textareaProps.onBlur?.(event); }}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        className="scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/55"
      />

      <div className="mt-1 flex min-h-8 flex-wrap items-center gap-1">
        <Button type="button" variant="ghost" size="icon" aria-label="选择 skill" title="选择 skill（/）" disabled={disabled || loading}
          onClick={() => { setSkillBrowseOpen(true); setSkillsDismissed(false); textareaRef.current?.focus({ preventScroll: true }); }}>
          <Puzzle className="size-4" />
        </Button>
        {actions.length ? (
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || loading}
                aria-label="Add to prompt"
                className="size-8 rounded-full"
              >
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: actionsOpen ? 45 : 0 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                >
                  <Plus className="size-4" />
                </motion.span>
              </Button>
            </MorphPopoverTrigger>

            <MorphPopoverContent
              side="top"
              align="start"
              sideOffset={8}
              radius={12}
              className="w-56 p-1.5"
            >
              {actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    onAction?.(action.value);
                    setActionsOpen(false);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.icon ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">
                      {action.label}
                    </span>
                    {action.description ? (
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {modes.length ? (
          <MorphPopover open={modesOpen} onOpenChange={setModesOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled || loading}
                aria-label="权限模式"
                className="h-8 rounded-xl px-2 py-0 text-xs hover:bg-muted focus-visible:ring-2"
              >
                <span className="flex items-center gap-1.5">
                  {currentMode?.icon ? (
                    <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
                      {currentMode.icon}
                    </span>
                  ) : (
                    <Shield className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="truncate text-muted-foreground">
                    {currentMode?.label ?? "权限模式"}
                  </span>
                </span>
              </Button>
            </MorphPopoverTrigger>

            {/* 向上展开：side="top"，从输入框上方选择权限模式；
                w-80 保证中文描述一行放得下，不换行 */}
            <MorphPopoverContent
              side="top"
              align="start"
              sideOffset={8}
              radius={12}
              className="w-80 p-1.5"
            >
              {modes.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => setMode(option.value)}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  {option.icon ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {option.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  {option.value === currentModeValue ? (
                    <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-accent">
                      <Check className="size-4" />
                    </span>
                  ) : null}
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {leadingAction}
        {models.length ? (
          <Select
            value={currentModelValue}
            onValueChange={setModel}
            disabled={disabled}
            className="min-w-0"
            searchable
            searchPlaceholder="搜索模型…"
          >
            <SelectTrigger className="h-8 w-auto max-w-52 rounded-xl border-0 bg-transparent px-2 py-0 text-xs hover:bg-muted focus-visible:ring-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {currentModel?.icon ? (
                  <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
                    {currentModel.icon}
                  </span>
                ) : null}
                <span className="truncate text-muted-foreground">
                  {currentModel?.label ?? "Choose model"}
                </span>
              </span>
            </SelectTrigger>
            <SelectContent className="right-auto w-80 shadow-none">
              {modelHint ? <div className="border-b border-border/60 px-2 py-2 text-xs leading-5 text-muted-foreground">{modelHint}</div> : null}
              {groupModels(models).flatMap((section) => [
                section.group
                  ? (<SelectGroupLabel
                      key={section.group}
                      searchText={`${section.group} ${section.options
                        .map((o) => `${o.value} ${String(o.label ?? "")}`)
                        .join(" ")}`}
                    >
                      {section.group}
                    </SelectGroupLabel>)
                  : null,
                ...section.options.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    searchText={`${option.value} ${String(option.label ?? "")}`}
                    className="py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {option.icon ? (
                        <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                          {option.icon}
                        </span>
                      ) : null}
                      <span className="min-w-0 truncate text-sm text-foreground">
                        {option.label}
                      </span>
                    </span>
                  </SelectItem>
                )),
              ])}
            </SelectContent>
          </Select>
        ) : null}

        {trailingAction}

        <Button
          type={loading ? "button" : "submit"}
          size="icon"
          disabled={loading ? !onStop : !canSubmit}
          aria-label={loading ? "Stop generating" : "Send prompt"}
          onClick={loading ? onStop : undefined}
          className="ml-auto size-8 rounded-full"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={loading ? "stop" : "send"}
              initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="grid place-items-center"
            >
              {loading ? (
                <Square className="size-3 fill-current" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        </Button>
      </div>
    </form>
  );
}
