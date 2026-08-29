import { useEffect, useMemo, useState } from "react";
import {
  ToolApproval,
  ToolApprovalCode,
  type ToolApprovalParameter,
  type ToolApprovalStatus,
} from "./agents/tool-approval";
import { APPROVAL_TTL_MS } from "@hello-agent/shared";
import { store, useStore, type PendingApproval } from "../store";

// §7.2 approval lifecycle, Renderer side: one beUI ToolApproval per pending
// requestId, resolved only via approval.resolve; Main owns cancellation/TTL.
// 倒计时基于事件 createdAt + 共享 TTL 常量；≤10s 变红提示即将过期。

function useCountdown(createdAt: number): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((createdAt + APPROVAL_TTL_MS - Date.now()) / 1000)),
  );

  useEffect(() => {
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((createdAt + APPROVAL_TTL_MS - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [createdAt]);

  return remaining;
}

/** displayInput 是 JSON.stringify 后的工具入参；能解析就逐字段展示。 */
function parseParameters(p: PendingApproval): ToolApprovalParameter[] {
  const raw = p.displayInput.text;
  if (!raw) return [];
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.entries(obj as Record<string, unknown>).map(([key, value]) => {
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
        const long = text.length > 80 || text.includes("\n");
        return {
          id: key,
          label: key,
          value: long ? (
            <ToolApprovalCode
              code={text}
              language={key === "command" ? "bash" : "json"}
            />
          ) : (
            text
          ),
        };
      });
    }
  } catch {
    /* 非 JSON 入参，走原始文本展示 */
  }
  return [
    {
      id: "input",
      label: "输入",
      value: <ToolApprovalCode code={raw} />,
    },
  ];
}

function ApprovalCardItem({ p }: { p: PendingApproval }) {
  const [submitting, setSubmitting] = useState(false);
  const remaining = useCountdown(p.createdAt);
  const parameters = useMemo(() => parseParameters(p), [p]);
  const status: ToolApprovalStatus = submitting ? "approving" : "pending";

  const resolve = (decision: "allow" | "allow-once" | "deny") => {
    setSubmitting(true);
    void store.resolveApproval(p.requestId, decision);
  };

  return (
    <ToolApproval
      tool={p.toolName}
      title="允许执行该操作？"
      description={
        <span className={remaining <= 10 ? "font-medium text-danger" : undefined}>
          {remaining > 0
            ? `${remaining}s 内未选择将自动拒绝。`
            : "即将过期…"}
        </span>
      }
      parameters={parameters}
      defaultOpen
      status={status}
      approveLabel="允许（仅本次）"
      alwaysAllowLabel="本次对话始终允许"
      denyLabel="拒绝"
      onApprove={() => resolve("allow-once")}
      onAlwaysAllow={() => resolve("allow")}
      onDeny={() => resolve("deny")}
    />
  );
}

export function ApprovalStack() {
  const s = useStore();
  if (s.pendingApprovals.length === 0) return null;

  return (
    <div className="mb-3 flex flex-col gap-2">
      {s.pendingApprovals.map((p) => (
        <ApprovalCardItem key={p.requestId} p={p} />
      ))}
    </div>
  );
}
