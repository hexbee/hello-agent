// PermissionManager — Main-process security boundary. §4.2 trust matrix, §7 approvals.
//
// Registered as the ONLY inline extension factory (§4.3); maps product decisions
// onto pi's tool_call contract: allow = return undefined, deny = { block: true },
// ask = await approval promise inside the handler, then allow or block.

import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { SafePreview } from "@hello-agent/shared";
import { safePreview, type TrustLevel } from "./host.js";

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
/** §4.2: Restricted runtimes are created with exactly this tool allowlist. */
export const RESTRICTED_TOOL_ALLOWLIST: string[] = [...READ_ONLY_TOOLS];

const HIGH_RISK_BASH = [
  /\brm\s+(-rf?|--recursive)/i,
  /\bsudo\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

export type ApprovalDecision = "allow" | "allow-once" | "deny" | "cancelled" | "expired";

export interface PendingApproval {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  displayInput: SafePreview;
  createdAt: number;
  status: "pending" | "resolved" | "cancelled" | "expired";
}

export interface AuditRecord {
  timestamp: number;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  decision: ApprovalDecision | "auto-allow";
  reason?: string;
  /** Redacted structural summary only — never raw input. */
  inputSummary: SafePreview;
}

interface PendingEntry extends PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export interface PermissionManagerOptions {
  getTrust(): TrustLevel;
  getCwd(): string; // canonical
  getSessionId(): string;
  ttlMs?: number;
  onApprovalRequested(pending: PendingApproval): void;
  onApprovalResolved(pending: PendingApproval, decision: ApprovalDecision): void;
  audit(record: AuditRecord): void;
}

let seq = 0;
function nextId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${(seq++).toString(36)}`;
}

export class PermissionManager {
  private pending = new Map<string, PendingEntry>();
  /** Session-scoped allow rules granted via approval dialog ("allow for session"). §7.1 */
  private sessionAllows = new Set<string>();
  /** Times the factory was instantiated (= sessions it guards). Probe hook. */
  bindCount = 0;

  constructor(private opts: PermissionManagerOptions) {}

  /** The inline extension factory — registered via resourceLoaderOptions.extensionFactories. */
  readonly factory = (pi: ExtensionAPI): void => {
    this.bindCount++;
    pi.on("tool_call", async (event: ToolCallEvent) => {
      const verdict = await this.gate(event);
      if (verdict.kind === "pass") return undefined; // pi treats handler return as pass-through
      return { block: true, reason: verdict.reason };
    });
    // §4.3: bypass pi's built-in project trust entirely — product trust is the
    // single decision source; never read or write ~/.pi/agent/trust.json.
    pi.on("project_trust", () => ({ trusted: "no" as const, remember: false }));
  };

  async gate(
    event: ToolCallEvent,
  ): Promise<{ kind: "pass" } | { kind: "block"; reason: string }> {
    const audit = (decision: AuditRecord["decision"], reason?: string) =>
      this.opts.audit({
        timestamp: Date.now(),
        sessionId: this.opts.getSessionId(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        decision,
        reason,
        inputSummary: safePreview(event.input),
      });

    // Untrusted workspaces have no runtime at all (§4.2) — defense in depth.
    if (this.opts.getTrust() === "untrusted") {
      audit("deny", "workspace untrusted");
      return { kind: "block", reason: "Workspace is not trusted" };
    }

    const readOnly = (READ_ONLY_TOOLS as readonly string[]).includes(event.toolName);

    if (readOnly) {
      const boundary = this.checkPathBoundary(event.input);
      if (!boundary.ok) {
        audit("deny", boundary.reason);
        return { kind: "block", reason: boundary.reason };
      }
      audit("auto-allow", "read-only within workspace");
      return { kind: "pass" };
    }

    // Restricted: write/edit/bash etc. are simply unavailable (runtime created
    // with the restricted allowlist — anything reaching here is a bug).
    if (this.opts.getTrust() === "restricted") {
      audit("deny", "restricted workspace forbids non-read-only tools");
      return { kind: "block", reason: "Restricted workspace allows read-only tools only" };
    }

    // ── Trusted ──
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown })?.command ?? "");
      const highRisk = HIGH_RISK_BASH.some((p) => p.test(command));
      if (!highRisk && this.sessionAllows.has("bash")) {
        audit("auto-allow", "session rule");
        return { kind: "pass" };
      }
    } else if (this.sessionAllows.has(event.toolName)) {
      audit("auto-allow", "session rule");
      return { kind: "pass" };
    }

    // ── ASK ──
    const requestId = nextId("req");
    const displayInput = safePreview(event.input);
    const entry: PendingEntry = {
      requestId,
      sessionId: this.opts.getSessionId(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      displayInput,
      createdAt: Date.now(),
      status: "pending",
      resolve: () => {},
      timer: null as unknown as NodeJS.Timeout,
    };

    const decision = await new Promise<ApprovalDecision>((resolvePromise) => {
      entry.resolve = resolvePromise;
      entry.timer = setTimeout(() => {
        if (entry.status !== "pending") return;
        entry.status = "expired";
        this.pending.delete(requestId);
        this.opts.onApprovalResolved(entry, "expired");
        resolvePromise("expired");
      }, this.opts.ttlMs ?? 60_000);
      this.pending.set(requestId, entry);
      this.opts.onApprovalRequested({ ...entry });
    });

    clearTimeout(entry.timer);
    entry.status =
      decision === "allow" || decision === "allow-once" || decision === "deny"
        ? "resolved"
        : decision;

    if (decision === "allow" || decision === "allow-once") {
      // allow-once 仅本次放行；只有 allow 写入会话规则（§7.1）。
      if (decision === "allow") {
        if (event.toolName === "bash") {
          const command = String((event.input as { command?: unknown })?.command ?? "");
          if (!HIGH_RISK_BASH.some((p) => p.test(command))) this.sessionAllows.add("bash");
        } else {
          this.sessionAllows.add(event.toolName);
        }
      }
      audit(decision);
      return { kind: "pass" };
    }

    audit(decision, `approval ${decision}`);
    return { kind: "block", reason: `Approval ${decision}` };
  }

  /**
   * Path boundary check — realpath every path-like field and require it inside
   * the canonical cwd. Rejects symlink escape. §4.2
   */
  checkPathBoundary(input: unknown): { ok: true } | { ok: false; reason: string } {
    if (input === null || typeof input !== "object") return { ok: true };
    // Defensive canonicalize — macOS /var ↔ /private/var style symlinks would
    // otherwise false-negative the prefix match.
    let cwd: string | undefined;
    try {
      cwd = realpathSync(this.opts.getCwd());
    } catch {
      return { ok: false, reason: "workspace cwd unresolvable" };
    }
    if (!cwd) return { ok: false, reason: "no workspace" };
    const candidates = Object.entries(input as Record<string, unknown>).filter(([k]) =>
      ["path", "file_path", "file"].includes(k),
    );
    for (const [field, raw] of candidates) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        // Path may not exist yet (write targets). Resolve nearest existing ancestor.
        const parent = abs.slice(0, abs.lastIndexOf(sep)) || sep;
        try {
          real = realpathSync(parent);
        } catch {
          return { ok: false, reason: `unresolvable path in '${field}'` };
        }
      }
      if (real !== cwd && !real.startsWith(cwd + sep)) {
        return { ok: false, reason: `'${field}' escapes workspace` };
      }
    }
    return { ok: true };
  }

  /** First valid response wins; stale/forged requests rejected (§7.2). */
  resolveApproval(
    requestId: string,
    sessionId: string,
    decision: "allow" | "allow-once" | "deny",
  ): { ok: true } | { ok: false; reason: string } {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, reason: "unknown or already-resolved requestId" };
    if (entry.sessionId !== sessionId) return { ok: false, reason: "sessionId mismatch" };
    if (entry.status !== "pending") return { ok: false, reason: `not pending (${entry.status})` };
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(decision);
    this.opts.onApprovalResolved(entry, decision);
    return { ok: true };
  }

  /** Cancel all pending → handlers resolve 'cancelled' → pi sees block. §7.2 */
  cancelAll(reason: string): number {
    let n = 0;
    for (const [id, entry] of [...this.pending]) {
      if (entry.status !== "pending") continue;
      clearTimeout(entry.timer);
      entry.status = "cancelled";
      this.pending.delete(id);
      entry.resolve("cancelled");
      this.opts.onApprovalResolved(entry, "cancelled");
      this.opts.audit({
        timestamp: Date.now(),
        sessionId: entry.sessionId,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        decision: "cancelled",
        reason,
        inputSummary: entry.displayInput,
      });
      n++;
    }
    return n;
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()]
      .filter((e) => e.status === "pending")
      .map(({ resolve: _r, timer: _t, ...rest }) => rest);
  }

  resetSessionRules(): void {
    this.sessionAllows.clear();
  }
}

/** JSONL audit sink with an in-memory queue flushed asynchronously (§7.2). */
export function createAuditSink(file: string | undefined) {
  const queue: AuditRecord[] = [];
  let flushing = false;
  return {
    enqueue(record: AuditRecord): void {
      queue.push(record);
      void drain();
    },
    size(): number {
      return queue.length;
    },
  };

  async function drain() {
    if (flushing || !file) return;
    flushing = true;
    try {
      const { appendFile, mkdir } = await import("node:fs/promises");
      while (queue.length > 0) {
        const batch = queue.splice(0, 100);
        await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        await appendFile(file, batch.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      }
    } catch {
      // §7.2: flush failure warns, never blocks tool handlers.
      console.warn("[audit] flush failed;", queue.length, "records dropped");
      queue.length = 0;
    } finally {
      flushing = false;
    }
  }
}
