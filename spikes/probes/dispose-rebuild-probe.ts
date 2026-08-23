// §10.4 — Agent exception → window still usable; runtime dispose + rebuild in
// same cwd; pending approvals cancelled on teardown.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import type { AgentHost, AgentHostPaths } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@spike/shared";
import { exitOn, Reporter } from "./harness.js";

const r = new Reporter();
await r.run("dispose-rebuild", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-rebuild-"));
  const project = join(root, "project");
  const appData = join(root, "appdata");
  const { mkdirSync } = await import("node:fs");
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
  const host: AgentHost = {
    paths,
    getCwd: () => project,
    getTrust: () => trust,
    emit: (_e: AgentEvent) => {},
    getEnvKey: () => undefined,
  };
  const permissions = new PermissionManager({
    getTrust: () => trust,
    getCwd: () => project,
    getSessionId: () => adapter?.sessionId ?? "",
    ttlMs: 30_000,
    onApprovalRequested: () => {},
    onApprovalResolved: () => {},
    audit: () => {},
  });
  let adapter = new PiAdapter(host, permissions);

  await adapter.create(project);
  const firstSessionId = adapter.sessionId;
  r.check("initial runtime created", !!firstSessionId);

  // Simulate agent failure: dispose must work even mid-"running" state.
  // (A real LLM failure surfaces as failed state via events; here we exercise
  // the §4.5 recovery path itself.)
  await adapter.dispose();

  // Rebuild in the same cwd — the "重建 runtime" affordance.
  adapter = new PiAdapter(host, permissions);
  await adapter.create(project);
  r.check("rebuilt runtime usable in same cwd", !!adapter.sessionId);
  r.check(
    "rebind count grew across rebuild",
    permissions.bindCount >= 2,
    String(permissions.bindCount),
  );

  // Pending approval at teardown time is cancelled (window-close semantics).
  let cancelledSeen = false;
  const pm2 = new PermissionManager({
    getTrust: () => "trusted",
    getCwd: () => project,
    getSessionId: () => "sess-x",
    ttlMs: 30_000,
    onApprovalRequested: () => {},
    onApprovalResolved: (_p, decision) => {
      if (decision === "cancelled") cancelledSeen = true;
    },
    audit: () => {},
  });
  const gatePromise = pm2.gate({
    type: "tool_call",
    toolCallId: "tc-x",
    toolName: "bash",
    input: { command: "sleep 5" },
  } as never);
  await new Promise((res) => setTimeout(res, 20));
  pm2.cancelAll("host exit");
  const v = await gatePromise;
  r.check("pending approval cancelled on host exit", v.kind === "block" && cancelledSeen);

  // abort() while idle is safe
  await adapter.abort();
  r.check("abort while idle is safe", adapter.getState() !== "failed");

  await adapter.dispose();
}
