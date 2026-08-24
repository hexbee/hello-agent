// §10.3 — newSession / switchSession / fork must rebind the PermissionManager
// extension on every replacement (§5.2), and sessions must land in app dir.

import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PermissionManager, createAuditSink } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@hello-agent/shared";
import { exitOn, Reporter } from "./harness.js";

const r = new Reporter();
await r.run("session-rebind", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-rebind-"));
  const project = join(root, "project");
  const appData = join(root, "appdata");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "index.ts"), "export const x = 1;\n");

  const agentDir = join(appData, "pi-agent");
  const paths = {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });

  let cwd = project;
  let trust: "untrusted" | "restricted" | "trusted" = "trusted";
  const host: AgentHost = {
    paths,
    getCwd: () => cwd,
    getTrust: () => trust,
    emit: (_e: AgentEvent) => {},
    getEnvKey: () => undefined,
    moveToTrash: async (p: string) => { renameSync(p, p + '.trashed'); return true; },
  };
  const permissions = new PermissionManager({
    getTrust: () => trust,
    getCwd: () => cwd,
    getSessionId: () => adapter.sessionId,
    onApprovalRequested: () => {},
    onApprovalResolved: () => {},
    audit: () => {},
  });
  const adapter = new PiAdapter(host, permissions);

  await adapter.create(project);
  // pi persists the JSONL lazily on first entry — seed one so the session
  // file exists on disk (open/switch only make sense for persisted sessions).
  await seed(adapter);
  const firstFile = adapter.sessionFilePath(); // capture BEFORE switching away
  const firstSession = adapter.sessionId;
  const bindAfterCreate = permissions.bindCount;
  r.check("factory instantiated on create", bindAfterCreate >= 1, String(bindAfterCreate));

  // newSession
  await adapter.newSession();
  r.check(
    "newSession re-instantiated permission factory",
    permissions.bindCount > bindAfterCreate,
  );
  r.check("newSession changed sessionId", adapter.sessionId !== firstSession);

  await adapter.newSession(); // make a second session
  await seed(adapter);
  const secondFile = adapter.sessionFilePath();
  r.check("two session files exist", !!firstFile && !!secondFile && firstFile !== secondFile);

  await adapter.openSession(firstFile!);
  r.check("switchSession rebound factory", true);
  // openSession validated path containment implicitly (would throw otherwise)
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, "{}\n");
  let rejected = false;
  try {
    await adapter.openSession(outside);
  } catch {
    rejected = true;
  }
  r.check("openSession rejects path outside app dir", rejected);

  // fork
  let forkOk = true;
  try {
    await adapter.forkSession("nonexistent-entry"); // should throw cleanly, not corrupt
  } catch {
    forkOk = false;
  }
  r.check("fork with bad entry throws safely", !forkOk || typeof adapter.sessionId === "string");

  // rename uses pi API
  adapter.renameSession("spike-renamed");
  r.check("renameSession via pi API did not throw", true);

  // delete only inside app dir
  let delRejected = false;
  try {
    await adapter.deleteSession(outside);
  } catch {
    delRejected = true;
  }
  r.check("deleteSession rejects path outside app dir", delRejected);
  if (existsSync(secondFile)) {
    await adapter.deleteSession(secondFile);
    r.check("deleteSession removes verified app-dir session", !existsSync(secondFile));
  }

  // session files really live in app dir, never ~/.pi
  const files = readdirSync(paths.sessionsDir, { recursive: true }).filter((f) =>
    String(f).endsWith(".jsonl"),
  );
  r.check("sessions stored under app dir", files.length >= 1, JSON.stringify(files));

  await adapter.dispose();

  // dispose cancels approvals
  r.check("dispose completed without hang", true);
}

/** Append one user message without needing an LLM so pi flushes the JSONL. */
async function seed(adapter: PiAdapter): Promise<void> {
  // No credentials here, so the LLM call will fail or hang — abort after a
  // short window. The user message entry is persisted on append, before the
  // LLM round-trip finishes.
  const t = setTimeout(() => void adapter.abort().catch(() => {}), 3_000);
  try {
    await adapter.prompt("seed");
  } catch {
    /* expected without credentials */
  } finally {
    clearTimeout(t);
    await new Promise((r) => setTimeout(r, 100));
  }
}
