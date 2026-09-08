/** Offline regression for official discovery and the app's session factory. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { skillCommandForDisplay } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import { discoverSkills, makeServicesFactory, skillPathsFromArgs } from "../../apps/desktop/src/main/agent/isolation.js";
import { ModelRuntime, SessionManager, createAgentSessionRuntime } from "../../apps/desktop/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "hello-skills-"));
const savedHome = process.env.HOME;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const home = join(root, "home");
const agentDir = join(home, ".pi/agent");
const project = join(root, "project");
const cwd = join(project, "child");
function file(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function skill(base: string, name: string, extra = "") {
  const path = join(base, name, "SKILL.md");
  file(path, `---\nname: ${name}\ndescription: Test ${name}\n${extra}---\nInstructions for ${name}. Read references/example.md.\n`);
  return path;
}
try {
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  skill(join(agentDir, "skills"), "global-pi");
  skill(join(home, ".agents/skills"), "global-agents");
  skill(join(cwd, ".pi/skills"), "project-pi");
  skill(join(cwd, ".agents/skills"), "project-agents");
  skill(join(project, ".agents/skills"), "ancestor");
  skill(join(root, ".agents/skills"), "outside-repo");
  skill(join(agentDir, "custom"), "global-setting");
  skill(join(cwd, ".pi/custom"), "project-setting");
  skill(join(agentDir, "skills"), "manual-only", "disable-model-invocation: true\n");
  skill(join(agentDir, "skills"), "collision");
  skill(join(cwd, ".pi/skills"), "collision");
  file(join(agentDir, "skills/broken/SKILL.md"), "---\nname: broken\n---\nNo description");
  const packageDir = join(root, "package");
  skill(join(packageDir, "skills"), "package-skill");
  file(join(packageDir, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["skills"], extensions: ["evil.js"] } }));
  file(join(packageDir, "evil.js"), 'throw new Error("Extension must not execute")');
  file(join(agentDir, "settings.json"), JSON.stringify({ skills: ["custom"], packages: [packageDir] }));
  file(join(cwd, ".pi/settings.json"), JSON.stringify({ skills: ["custom"] }));
  const explicit = skill(join(root, "explicit"), "explicit");
  assert.deepEqual(skillPathsFromArgs(["app", "--skill", explicit, "--skill=/tmp/other"]), [explicit, "/tmp/other"]);
  assert.throws(() => skillPathsFromArgs(["--skill"]));
  const loaded = await discoverSkills(cwd, "trusted", agentDir, [explicit]);
  const names = loaded.skills.map((s) => s.name);
  for (const name of ["global-pi", "global-agents", "project-pi", "project-agents", "ancestor", "global-setting", "project-setting", "package-skill", "explicit", "manual-only"]) assert(names.includes(name), name);
  assert(!names.includes("outside-repo"));
  assert(!names.includes("broken"));
  assert.equal(names.filter((name) => name === "collision").length, 1);
  assert(loaded.diagnostics.some((d) => d.type === "collision"));
  assert(loaded.diagnostics.some((d) => d.path?.includes("broken")));
  const restricted = await discoverSkills(cwd, "restricted", agentDir);
  assert(restricted.skills.some((s) => s.name === "global-pi"));
  assert(!restricted.skills.some((s) => ["project-pi", "project-agents", "ancestor", "project-setting"].includes(s.name)));
  console.log("✓ official paths, settings, packages, explicit paths, trust, diagnostics and collisions");

  const appDir = join(root, "app");
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: join(appDir, "models.json"), modelsStorePath: join(appDir, "models-store.json") });
  const runtime = await createAgentSessionRuntime(makeServicesFactory({
    paths: { agentDir: appDir, sessionsDir: join(appDir, "sessions"), modelsPath: join(appDir, "models.json"), modelsStorePath: join(appDir, "models-store.json"), auditFile: join(appDir, "audit.jsonl") },
    modelRuntime,
    trust: "trusted",
    permissionExtension: { name: "test-permission", factory: () => {} },
  }), { cwd, agentDir: appDir, sessionManager: SessionManager.inMemory(cwd) });
  try {
    assert(runtime.session.resourceLoader.getSkills().skills.some((s) => s.name === "global-pi"));
    assert(runtime.session.systemPrompt.includes("global-pi"));
    assert(!runtime.session.systemPrompt.includes("manual-only"));
    // Exercise the SDK's actual expansion without an LLM/network request.
    const expanded = (runtime.session as unknown as { _expandSkillCommand(text: string): string })._expandSkillCommand("/skill:manual-only do the task");
    assert(expanded.includes("Instructions for manual-only"));
    assert(expanded.includes("do the task"));
    assert.equal(skillCommandForDisplay(expanded), "/skill:manual-only do the task");
    assert.equal(skillCommandForDisplay("ordinary message"), "ordinary message");
    assert(expanded.includes("References are relative to"));
    skill(join(cwd, ".pi/skills"), "added-later");
    await runtime.newSession();
    assert(runtime.session.resourceLoader.getSkills().skills.some((s) => s.name === "added-later"));
    console.log("✓ app runtime prompt injection, manual command expansion and new-session rediscovery");
  } finally { await runtime.dispose(); }
} finally {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(root, { recursive: true, force: true });
}
