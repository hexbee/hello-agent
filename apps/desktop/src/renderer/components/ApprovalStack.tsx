import { store, useStore } from "../store";

// §7.2 approval lifecycle, Renderer side: one card per pending requestId,
// resolved only via approval.resolve; Main owns cancellation/TTL.
export function ApprovalStack() {
  const s = useStore();
  if (s.pendingApprovals.length === 0) return null;

  return (
    <div className="mb-3 flex flex-col gap-2">
      {s.pendingApprovals.map((p) => (
        <div
          key={p.requestId}
          className="rounded-xl border border-accent/40 bg-panel p-3 shadow-lg"
        >
          <div className="flex items-center gap-2">
            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[11px] font-medium text-accent">
              需要审批
            </span>
            <span className="font-mono text-xs font-medium">{p.toolName}</span>
          </div>
          {p.displayInput.text && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-bg p-2 font-mono text-xs whitespace-pre-wrap">
              {p.displayInput.text}
            </pre>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-panel-2"
              onClick={() => void store.resolveApproval(p.requestId, "deny")}
            >
              拒绝
            </button>
            <button
              className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              onClick={() => void store.resolveApproval(p.requestId, "allow")}
            >
              允许（本次）
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
