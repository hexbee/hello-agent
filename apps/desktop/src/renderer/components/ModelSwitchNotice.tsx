import { ArrowRight, Check, Clock3, Info, X } from "lucide-react";
import { store, useStore } from "../store";

const modelName = (ref: string | null) => ref?.split("/").slice(1).join("/") || "当前模型";
const tokens = (value: number) => new Intl.NumberFormat("en-US", {
  notation: "compact", maximumFractionDigits: 1,
}).format(value).toLowerCase();

/** Model changes belong beside the composer; never take over the global banner. */
export function ModelSwitchNotice() {
  const s = useStore();
  const notice = s.modelNotice ?? (s.pendingModel ? {
    phase: "queued" as const, from: s.selectedModel, target: s.pendingModel,
  } : null);
  if (!notice) return null;
  const queued = notice.phase === "queued";
  const switched = notice.phase === "switched";
  const cancelled = notice.phase === "cancelled";
  const from = s.models.find((m) => `${m.provider}/${m.id}` === notice.from);
  const target = s.models.find((m) => `${m.provider}/${m.id}` === notice.target);
  const used = s.contextUsage?.tokens;
  const capacity = target?.context;
  const hasHistory = s.entries.length > 0 || s.agentState === "running";
  const exceeds = capacity != null && used != null && used >= capacity;
  const smaller = capacity != null && from?.context != null && capacity < from.context;
  const providerChanged = notice.from && notice.target && notice.from.split("/")[0] !== notice.target.split("/")[0];
  const Icon = queued ? Clock3 : switched || cancelled ? Check : Info;

  return (
    <section aria-label="模型切换提示" className="mb-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div role="status" className="text-xs font-medium leading-5 text-foreground">
            {queued ? "本轮结束后切换" : switched ? "模型已切换，下条消息生效" : cancelled ? "已取消切换，继续使用当前模型" : "未能切换模型"}
          </div>
          {!cancelled && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              <span>{modelName(notice.from)}</span>
              <ArrowRight aria-hidden="true" className="size-3 shrink-0" />
              <span className="text-foreground">{modelName(notice.target)}</span>
            </div>
          )}
        </div>
        {queued ? (
          <button type="button" onClick={() => { if (s.selectedModel) void store.selectModel(s.selectedModel); }}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-xs leading-5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20">
            取消切换
          </button>
        ) : (
          <button type="button" aria-label="关闭模型切换提示" onClick={() => store.dismissModelNotice()}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {notice.phase === "error" ? (
        <p className="mt-1 pl-5.5 text-xs leading-5 text-muted-foreground">{notice.error ?? "切换失败，当前模型保持不变。"}</p>
      ) : !cancelled && (
        <div className="mt-1 space-y-1 pl-5.5 text-xs leading-5 text-muted-foreground">
          {queued && <p>当前处理不会中断。再次选择模型可更改待切换目标。</p>}
          {hasHistory && <p>对话历史会保留，但新模型对历史的理解和后续判断可能不同。</p>}
          {hasHistory && exceeds ? (
            <p className="text-amber-600 dark:text-amber-400">当前上下文约 {tokens(used!)} tokens，目标窗口 {tokens(capacity!)}。后续可能需要压缩历史、丢失部分细节，或因超限而失败。</p>
          ) : hasHistory && smaller ? (
            <p>上下文窗口从 {tokens(from!.context!)} 缩小至 {tokens(capacity!)} tokens。长对话可能需要压缩，部分细节可能丢失。</p>
          ) : null}
          {hasHistory && providerChanged && <p>服务商变更为 {target?.provider ?? notice.target?.split("/")[0]}；继续发送消息时，当前上下文会提交给新服务商。</p>}
        </div>
      )}
    </section>
  );
}
