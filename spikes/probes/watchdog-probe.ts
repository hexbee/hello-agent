// ADR 遗留项：卡死注入测试（§4.5 watchdog）。
//
// 需要 DEEPSEEK_API_KEY（无 key 时 SKIP）。验证：
// - bash 工具被挂起（永不返回的 tool_call 扩展 handler）→ pi 事件流静默
// - watchdog 超时后：agent.failed(runtime) + agent.state=failed
// - 释放挂起后 rebuild() 成功：新 runtime 可用、绑定重建、会话可列出
//
// 运行：DEEPSEEK_API_KEY=sk-... pnpm probe:watchdog

import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import type { AgentHost, AgentHostPaths } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@hello-agent/shared";
import { exitOn, Reporter } from "./harness.js";

const MARKER = "HANG-FOREVER-MARKER";
const WATCHDOG_MS = 1_500;

if (!process.env.DEEPSEEK_API_KEY) {
  console.log("[probe] watchdog: DEEPSEEK_API_KEY 未设置，SKIP");
  process.exit(0);
}

const r = new Reporter();
await r.run("watchdog", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-watchdog-"));
  const project = join(root, "project");
  const appData = join(root, "appdata");
  mkdirSync(project, { recursive: true });

  const paths: AgentHostPaths = {
    agentDir: join(appData, "pi-agent"),
    sessionsDir: join(appData, "pi-agent", "sessions"),
    modelsPath: join(appData, "pi-agent", "models.json"),
    modelsStorePath: join(appData, "pi-agent", "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });

  let trust: "untrusted" | "restricted" | "trusted" = "trusted";
  const events: AgentEvent[] = [];
  const host: AgentHost = {
    paths,
    getCwd: () => project,
    getTrust: () => trust,
    emit: (e) => {
      events.push(e);
      // Release the hang once the watchdog declares failure.
      if (e.type === "agent.failed") hangRelease?.();
    },
    getEnvKey: () => process.env.DEEPSEEK_API_KEY,
    moveToTrash: async (p) => {
      renameSync(p, `${p}.trashed`);
      return true;
    },
    watchdogTimeoutMs: WATCHDOG_MS,
  };

  // ── hang injection extension (probe seam via extraExtensions) ──
  let hangRelease: (() => void) | undefined;
  const hangInjector: InlineExtension = {
    name: "hang-injector",
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        const cmd = String((event.input as { command?: unknown })?.command ?? "");
        if (event.toolName === "bash" && cmd.includes(MARKER)) {
          await new Promise<void>((resolve) => {
            hangRelease = resolve;
          });
        }
        return undefined; // pass through after release
      });
    },
  };

  const permissions = new PermissionManager({
    getTrust: () => trust,
    getCwd: () => project,
    getSessionId: () => adapter.sessionId,
    ttlMs: 120_000,
    onApprovalRequested: (p) => {
      // Auto-allow so the bash call reaches the hang injector.
      setTimeout(() => permissions.resolveApproval(p.requestId, adapter.sessionId, "allow"), 50);
    },
    onApprovalResolved: () => {},
    audit: () => {},
  });

  let adapter = new PiAdapter(host, permissions, { extraExtensions: [hangInjector] });
  await adapter.create(project);
  r.check("runtime created with hang injector", !!adapter.sessionId);
  await adapter.selectModel("deepseek/deepseek-v4-flash");
  const bindCountBefore = permissions.bindCount;

  // Trigger the hung bash call.
  const accepted = await adapter.prompt(`请执行 bash 命令：echo ${MARKER}（原样执行，不要改动）`);
  r.check("prompt accepted", accepted.accepted === true);

  // Wait for the watchdog to fire (hang starts after approval ~50ms).
  const failedEvent = await waitFor(
    () => events.find((e) => e.type === "agent.failed" && e.kind === "runtime"),
    30_000,
  );
  r.check("watchdog emitted agent.failed(runtime)", !!failedEvent);
  const stateFailed = await waitFor(
    () => events.find((e) => e.type === "agent.state" && e.state === "failed"),
    5_000,
  );
  r.check("watchdog set agent.state=failed", !!stateFailed);
  r.check("failure arrived after watchdog window", !!failedEvent);

  // Release the hang and rebuild — §4.5 recovery path.
  hangRelease?.();
  await new Promise((res) => setTimeout(res, 200));

  const rebuildResult = await adapter.rebuild();
  r.check("rebuild produced a new session", !!rebuildResult.sessionId);
  r.check("bindings re-created across rebuild", permissions.bindCount > bindCountBefore);
  r.check(
    "latest session restorable or fresh session present",
    rebuildResult.restoredSessionId !== undefined,
  );
  r.check("state reset to non-failed after rebuild", adapter.getState() !== "running");

  await adapter.dispose();
}

async function waitFor<T>(pred: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const v = pred();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) return undefined;
    await new Promise((res) => setTimeout(res, 100));
  }
}
