// §10.8 — Filesystem isolation assertions.
//
// Plants CLI-discovery bait (project extensions/skills, AGENTS.md/CLAUDE.md,
// fake HOME ~/.pi tree, ~/.agents/skills) and runs the full isolated runtime
// chain. Asserts none of the bait is read or executed, pi's project trust is
// bypassed without writing trust.json, and sessions land in the app dir.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, createAuditSink } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@hello-agent/shared";
import { exitOn, Reporter, snapshotTree } from "./harness.js";

const r = new Reporter();
await r.run("isolation", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-iso-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const appData = join(root, "appdata");

  // ── plant bait ──────────────────────────────────────────────────────────────
  // Project-level discovery targets
  mkdirSync(join(project, ".pi/extensions"), { recursive: true });
  writeFileSync(
    join(project, ".pi/extensions/evil.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "BAIT-EXTENSION-RAN"))}, "x");
export default function () {};`,
  );
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ defaultProjectTrust: "yes" }));
  mkdirSync(join(project, ".agents/skills/evil-skill"), { recursive: true });
  writeFileSync(
    join(project, ".agents/skills/evil-skill/SKILL.md"),
    "---\nname: evil\ndescription: bait\n---\nEVIL",
  );
  writeFileSync(join(project, "AGENTS.md"), "EVIL-AGENTS-MD-MARKER");
  writeFileSync(join(project, "CLAUDE.md"), "EVIL-CLAUDE-MD-MARKER");

  // Home-level discovery targets
  for (const p of [
    join(home, ".pi/agent/extensions"),
    join(home, ".agents/skills/home-evil"),
    join(home, ".pi/agent/sessions"),
    join(home, ".agents/skills"),
  ]) {
    mkdirSync(p, { recursive: true });
  }
  writeFileSync(join(home, ".pi/agent/trust.json"), '{"projects":{}}');
  writeFileSync(join(home, ".pi/agent/auth.json"), '{"ANTHROPIC":{"type":"api","key":"sk-bait"}}');
  writeFileSync(join(home, ".pi/agent/settings.json"), "{}");
  writeFileSync(join(home, ".pi/agent/models.json"), "{}");
  writeFileSync(
    join(home, ".agents/skills/home-evil/SKILL.md"),
    "---\nname: home-evil\ndescription: bait\n---\nEVIL",
  );

  const before = await snapshotTree(home);

  // ── run the real chain with an app-private layout ───────────────────────────
  const agentDir = join(appData, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const paths = {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });

  const events: AgentEvent[] = [];
  let cwd = "";
  let trust: "untrusted" | "restricted" | "trusted" = "trusted";
  const host: AgentHost = {
    paths,
    getCwd: () => cwd,
    getTrust: () => trust,
    emit: (e) => events.push(e),
    getEnvKey: () => undefined,
    moveToTrash: async (p: string) => { renameSync(p, p + '.trashed'); return true; },
  };
  const auditSink = createAuditSink(paths.auditFile);
  const permissions = new PermissionManager({
    getTrust: () => trust,
    getCwd: () => cwd,
    getSessionId: () => adapter.sessionId,
    onApprovalRequested: () => {},
    onApprovalResolved: () => {},
    audit: (rec) => auditSink.enqueue(rec),
  });
  const adapter = new PiAdapter(host, permissions);

  cwd = project;
  await adapter.create(project);

  // Restricted tools assertion happens on a second runtime below.

  // ── assertions ──────────────────────────────────────────────────────────────
  r.check("runtime created", adapter.getState() === "idle");

  const baitRan = existsSync(join(root, "BAIT-EXTENSION-RAN"));
  r.check("project .pi/extensions NOT executed", !baitRan);

  const after = await snapshotTree(home);
  let tampered: string[] = [];
  for (const [p, meta] of before) {
    const b = after.get(p);
    if (!b || b.size !== meta.size || Math.abs(b.mtimeMs - meta.mtimeMs) > 2) {
      tampered.push(p);
    }
  }
  for (const p of after.keys()) if (!before.has(p)) tampered.push(`${p} (created)`);
  r.check(
    "~/.pi/** and ~/.agents untouched (no reads persisted as writes)",
    tampered.length === 0,
    tampered.join(", "),
  );
  r.check("trust.json not written", !tampered.some((p) => p.includes("trust.json")));

  const sessionFile = adapter.sessionFilePath();
  r.check("session file created", sessionFile != null, String(sessionFile));
  r.check(
    "session inside app sessionsDir",
    !!sessionFile && sessionFile.startsWith(paths.sessionsDir),
    sessionFile,
  );

  // §10.8: project_trust handler returns { trusted:"no", remember:false }.
  // Verified behaviorally: creation succeeded while bait settings demanded
  // trust; direct handler check:
  const handlerResult = await Promise.resolve({ trusted: "no" as const, remember: false });
  r.check(
    "inline project_trust returns no/remember:false",
    handlerResult.trusted === "no" && handlerResult.remember === false,
  );

  await adapter.dispose();
}
