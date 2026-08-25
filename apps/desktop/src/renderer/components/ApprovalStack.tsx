import { useState } from "react";
import { ApprovalCard } from "./agents/approval-card";
import { store, useStore } from "../store";

// §7.2 approval lifecycle, Renderer side: one beUI ApprovalCard per pending
// requestId, resolved only via approval.resolve; Main owns cancellation/TTL.
export function ApprovalStack() {
  const s = useStore();
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());

  if (s.pendingApprovals.length === 0) return null;

  const resolve = (requestId: string, decision: "allow" | "deny") => {
    setSubmitting((prev) => new Set(prev).add(requestId));
    void store.resolveApproval(requestId, decision);
  };

  return (
    <div className="mb-3 flex flex-col gap-2">
      {s.pendingApprovals.map((p) => {
        const busy = submitting.has(p.requestId);
        return (
          <ApprovalCard
            key={p.requestId}
            title="需要审批"
            description={<span className="font-mono text-xs">{p.toolName}</span>}
            status={busy ? "submitting" : "pending"}
            approveLabel="允许（本次）"
            onApprove={() => resolve(p.requestId, "allow")}
            onReject={() => resolve(p.requestId, "deny")}
          >
            {p.displayInput.text && (
              <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-bg p-2 font-mono text-xs whitespace-pre-wrap">
                {p.displayInput.text}
              </pre>
            )}
          </ApprovalCard>
        );
      })}
    </div>
  );
}
