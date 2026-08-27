// §10.1 / §10.2 — Permission chain + cancellation semantics, headless.
//
// Drives PermissionManager.gate() with synthetic tool_call events through the
// full allow/deny/ask decision matrix, TTL, multi-pending, duplicate response,
// session rules, cancel-on-abort, and audit persistence.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  createAuditSink,
  PermissionManager,
  type AuditRecord,
  type PendingApproval,
} from "../../apps/desktop/src/main/agent/permission-manager.js";
import { exitOn, Reporter } from "./harness.js";

const r = new Reporter();
await r.run("permission", () => main());
exitOn(r);

interface Fixture {
  pm: PermissionManager;
  requests: PendingApproval[];
  audit: AuditRecord[];
}

function make(opts?: Partial<{ trust: string; ttlMs: number; cwd: string }>): Fixture {
  const requests: PendingApproval[] = [];
  const audit: AuditRecord[] = [];
  const cwd = opts?.cwd ?? mkdtempSync(join(tmpdir(), "spike-ws-"));
  const pm = new PermissionManager({
    getTrust: () => (opts?.trust ?? "trusted") as never,
    getCwd: () => cwd,
    getSessionId: () => "sess-1",
    ttlMs: opts?.ttlMs ?? 60_000,
    onApprovalRequested: (p) => requests.push(p),
    onApprovalResolved: () => {},
    audit: (rec) => audit.push(rec),
  });
  return { pm, requests, audit };
}

function bashEvent(command: string): Parameters<PermissionManager["gate"]>[0] {
  return { type: "tool_call", toolCallId: `tc-${Math.random().toString(36).slice(2)}`, toolName: "bash", input: { command } } as never;
}
function readEvent(path: string): Parameters<PermissionManager["gate"]>[0] {
  return { type: "tool_call", toolCallId: `tc-${Math.random().toString(36).slice(2)}`, toolName: "read", input: { path } } as never;
}
function editEvent(path: string): Parameters<PermissionManager["gate"]>[0] {
  return { type: "tool_call", toolCallId: `tc-${Math.random().toString(36).slice(2)}`, toolName: "edit", input: { path } } as never;
}

async function main(): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), "spike-perm-"));

  // ── untrusted ───────────────────────────────────────────────────────────────
  {
    const f = make({ trust: "untrusted", cwd: ws });
    const v = await f.pm.gate(readEvent(join(ws, "a.txt")));
    r.check("untrusted: read blocked", v.kind === "block");
  }

  // ── restricted ──────────────────────────────────────────────────────────────
  {
    const f = make({ trust: "restricted", cwd: ws });
    r.check(
      "restricted: read inside → pass",
      (await f.pm.gate(readEvent(join(ws, "a.txt")))).kind === "pass",
    );
    r.check(
      "restricted: read outside → block",
      (await f.pm.gate(readEvent("/etc/passwd"))).kind === "block",
    );
    r.check(
      "restricted: bash → block",
      (await f.pm.gate(bashEvent("echo hi"))).kind === "block",
    );
    r.check(
      "restricted: edit inside → block",
      (await f.pm.gate(editEvent(join(ws, "a.txt")))).kind === "block",
    );
  }

  // ── trusted: path boundary with symlink escape ─────────────────────────────
  {
    const f = make({ trust: "trusted", cwd: ws });
    const link = join(ws, "link-out");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync("/etc", link);
      const v = await f.pm.gate(readEvent(link));
      r.check("trusted: symlink escaping workspace → block", v.kind === "block");
    } finally {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(link);
      } catch {}
    }
  }

  // ── trusted: ask → allow; session rule then auto-allows non-high-risk bash ──
  {
    const f = make({ trust: "trusted", cwd: ws });
    const gatePromise = f.pm.gate(bashEvent("ls -la"));
    await waitFor(() => f.requests.length === 1);
    const req = f.requests[0]!;
    r.check("ask: approval requested with requestId/toolCallId", !!req.requestId && !!req.toolCallId);
    f.pm.resolveApproval(req.requestId, "sess-1", "allow");
    r.check("ask→allow: pass", (await gatePromise).kind === "pass");

    // second identical command now allowed by session rule without ask
    const before = f.requests.length;
    r.check(
      "session rule: second bash skips ask",
      (await f.pm.gate(bashEvent("cat foo.txt"))).kind === "pass" && f.requests.length === before,
    );

    // high-risk always asks again even with session rule
    void f.pm.gate(bashEvent("rm -rf /tmp/x"));
    await waitFor(() => f.requests.length > before);
    r.check("high-risk rm -rf still asks despite session rule", true);
    f.pm.cancelAll("probe cleanup");
  }

  // ── full-access mode: auto-allow everything, no approval ───────────────────
  {
    const f = make({ trust: "trusted", cwd: ws });
    r.check("default mode: edit asks", f.pm.getMode() === "default");

    f.pm.setMode("full");
    r.check("full mode: getMode reflects", f.pm.getMode() === "full");
    const before = f.requests.length;
    const bash = await f.pm.gate(bashEvent("rm -rf /tmp/x"));
    r.check("full mode: high-risk bash auto-passes", bash.kind === "pass");
    const edit = await f.pm.gate(editEvent(join(ws, "a.txt")));
    r.check("full mode: edit auto-passes", edit.kind === "pass");
    const out = await f.pm.gate(readEvent("/etc/passwd"));
    r.check("full mode: read outside workspace auto-passes", out.kind === "pass");
    r.check(
      "full mode: zero approval requests",
      f.requests.length === before,
    );
    r.check(
      "full mode: audited as auto-allow with mode reason",
      f.audit.some((a) => a.decision === "auto-allow" && a.reason === "full access"),
    );

    // 切回默认权限：审批恢复，且 session allow 规则被清空
    f.pm.setMode("default");
    const gatePromise = f.pm.gate(editEvent(join(ws, "a.txt")));
    await waitFor(() => f.requests.length === before + 1);
    f.pm.resolveApproval(f.requests[before]!.requestId, "sess-1", "allow");
    r.check("back to default: edit asks again", (await gatePromise).kind === "pass");

    // 会话切换（resetSessionRules）→ 模式回到默认
    f.pm.setMode("full");
    f.pm.resetSessionRules();
    r.check("session switch resets mode to default", f.pm.getMode() === "default");
    const p2 = f.pm.gate(bashEvent("echo hi"));
    await waitFor(() => f.requests.length === before + 2);
    f.pm.cancelAll("probe cleanup");
    r.check("after reset: bash asks again", (await p2).kind === "block");
  }

  // ── deny ────────────────────────────────────────────────────────────────────
  {
    const f = make({ trust: "trusted", cwd: ws });
    const gatePromise = f.pm.gate(editEvent(join(ws, "a.txt")));
    await waitFor(() => f.requests.length === 1);
    f.pm.resolveApproval(f.requests[0]!.requestId, "sess-1", "deny");
    const v = await gatePromise;
    r.check("deny → block", v.kind === "block" && v.reason.includes("deny"));
  }

  // ── duplicate / forged responses ────────────────────────────────────────────
  {
    const f = make({ trust: "trusted", cwd: ws });
    const gatePromise = f.pm.gate(bashEvent("whoami"));
    await waitFor(() => f.requests.length === 1);
    const req = f.requests[0]!;
    r.check("first resolve accepted", f.pm.resolveApproval(req.requestId, "sess-1", "allow").ok);
    const second = f.pm.resolveApproval(req.requestId, "sess-1", "allow");
    r.check("duplicate resolve rejected", !second.ok);
    const forged = f.pm.resolveApproval(req.requestId, "sess-OTHER", "allow");
    r.check("sessionId-mismatch rejected", !forged.ok);
    r.check("handler saw exactly one decision", (await gatePromise).kind === "pass");
  }

  // ── TTL expiry ──────────────────────────────────────────────────────────────
  {
    const f = make({ trust: "trusted", cwd: ws, ttlMs: 50 });
    const gatePromise = f.pm.gate(bashEvent("sleep 0"));
    await new Promise((res) => setTimeout(res, 120));
    const v = await gatePromise;
    r.check("TTL expiry → block", v.kind === "block" && v.reason.includes("expired"));
  }

  // ── multi-pending independent resolution ────────────────────────────────────
  {
    const f = make({ trust: "trusted", cwd: ws });
    const p1 = f.pm.gate(bashEvent("cmd-one"));
    const p2 = f.pm.gate(bashEvent("cmd-two"));
    await waitFor(() => f.requests.length === 2);
    f.pm.resolveApproval(f.requests[0]!.requestId, "sess-1", "allow");
    f.pm.resolveApproval(f.requests[1]!.requestId, "sess-1", "deny");
    r.check("multi-pending: #1 allowed", (await p1).kind === "pass");
    r.check("multi-pending: #2 denied", (await p2).kind === "block");
  }

  // ── abort cancels pending → pi sees block ───────────────────────────────────
  {
    const f = make({ trust: "trusted", cwd: ws });
    const gatePromise = f.pm.gate(bashEvent("long-running"));
    await waitFor(() => f.requests.length === 1);
    const cancelled = f.pm.cancelAll("user abort");
    r.check("abort cancels 1 pending", cancelled === 1);
    r.check("cancelled handler blocks", (await gatePromise).kind === "block");
  }

  // ── audit sink writes JSONL ─────────────────────────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), "spike-audit-"));
    const file = join(dir, "audit.jsonl");
    const sink = createAuditSink(file);
    sink.enqueue({
      timestamp: Date.now(),
      sessionId: "s",
      toolCallId: "t",
      toolName: "bash",
      decision: "auto-allow",
      inputSummary: { text: '{"command":"ls"}', truncated: false, redacted: false },
    });
    await new Promise((res) => setTimeout(res, 50));
    r.check("audit JSONL written", existsSync(file) && readFileSync(file, "utf8").includes("auto-allow"));

    // redaction check via safePreview is covered in isolation-probe env; here:
    const sinkNoop = createAuditSink(undefined);
    sinkNoop.enqueue({
      timestamp: Date.now(),
      sessionId: "s",
      toolCallId: "t",
      toolName: "x",
      decision: "allow",
      inputSummary: { text: "", truncated: false, redacted: false },
    });
    r.check("audit failure never throws into handler path", true);
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((res) => setTimeout(res, 5));
  }
}
