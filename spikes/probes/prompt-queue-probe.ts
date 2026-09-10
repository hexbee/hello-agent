import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "@hello-agent/shared";
import { MAX_QUEUED_PROMPTS, validateQueueAdd, validateQueueEdit, validateQueueRemove, validateQueueControl } from "../../packages/shared/src/index.js";
import { PromptQueueStore } from "../../apps/desktop/src/main/agent/prompt-queue.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";

const root = mkdtempSync(join(tmpdir(), "hello-prompt-queue-"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const until = async (check: () => boolean) => {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await tick();
  assert.ok(check(), "condition must settle within 2 seconds");
};
try {
  const file = join(root, "queue.json");
  const queues = new PromptQueueStore(file);
  queues.add("a", "one", "first", true);
  queues.add("a", "two", "second", true);
  queues.add("a", "one", "duplicate", true);
  assert.equal(queues.snapshot("a").items.length, 2);
  queues.edit("a", "two", "edited");
  assert.equal(queues.claim("a")?.id, "one");
  assert.throws(() => queues.edit("a", "one", "too late"), /busy/);
  assert.throws(() => queues.remove("a", "one"), /busy/);
  const restored = new PromptQueueStore(file);
  assert.equal(restored.snapshot("a").paused, true);
  assert.equal(restored.snapshot("a").items[0]?.status, "uncertain");
  assert.throws(() => restored.resume("a"), /busy/);
  restored.remove("a", "one");
  restored.resume("a");
  assert.equal(restored.claim("a")?.text, "edited");
  restored.complete("a", "two");
  restored.add("a", "two", "must not resurrect", true);
  assert.equal(restored.snapshot("a").items.length, 0);
  assert.equal(new PromptQueueStore(file).snapshot("a").items.length, 0);
  assert.equal(restored.snapshot("other").items.length, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
  for (let i = 0; i < MAX_QUEUED_PROMPTS; i++) queues.add("full", `id-${i}`, "text", true);
  assert.throws(() => queues.add("full", "overflow", "text", true), /busy/);
  const corrupt = join(root, "corrupt.json");
  writeFileSync(corrupt, "{ invalid");
  assert.deepEqual(new PromptQueueStore(corrupt).snapshot("a").items, []);
  assert.equal(validateQueueAdd({ sessionId: "a", id: "i", text: "ok" }).ok, true);
  assert.equal(validateQueueAdd({ sessionId: "a", id: "i", text: " " }).ok, false);
  assert.equal(validateQueueEdit({ sessionId: "a", id: "i", text: "x".repeat(100001) }).ok, false);
  assert.equal(validateQueueRemove({ id: "i" }).ok, false);
  assert.equal(validateQueueControl({ sessionId: "a", paused: "yes" }).ok, false);
  console.log("✓ durable claim, uncertain restart, per-item edit/remove, duplicate-ID protection, limits and IPC validation");

  const events: AgentEvent[] = [];
  const host: AgentHost = {
    paths: { agentDir: root, sessionsDir: root, modelsPath: join(root, "models.json"), modelsStorePath: join(root, "catalog.json"), auditFile: join(root, "audit.jsonl") },
    getCwd: () => root, getTrust: () => "trusted", emit: (e) => events.push(e),
    getEnvKey: () => undefined, moveToTrash: async () => true,
  };
  const permissions = new PermissionManager({ getCwd: () => root, getTrust: () => "trusted", getSessionId: () => "session-a",
    onApprovalRequested: () => {}, onApprovalResolved: () => {}, audit: () => {} });
  const adapter = new PiAdapter(host, permissions, { promptQueues: new PromptQueueStore() });
  const seam = adapter as unknown as { session: AgentSession; state: string; lastError?: string; onPiEvent: (e: AgentSessionEvent) => void };
  let idle = false;
  let rejectNext = false;
  let preflightGate: Promise<void> | undefined;
  let runDone: (() => void) | undefined;
  const sent: string[] = [];
  const finish = () => {
    idle = true;
    runDone?.();
    runDone = undefined;
    seam.onPiEvent({ type: "agent_settled" });
  };
  seam.session = {
    sessionId: "session-a", get isIdle() { return idle; },
    getContextUsage: () => null,
    prompt: async (text: string, options: { preflightResult?: (ok: boolean) => void }) => {
      await preflightGate;
      if (rejectNext) { rejectNext = false; options.preflightResult?.(false); throw new Error("no auth"); }
      options.preflightResult?.(true);
      sent.push(text);
      idle = false;
      seam.onPiEvent({ type: "agent_start" });
      await new Promise<void>((resolve) => { runDone = resolve; });
    },
    abort: async () => { finish(); },
  } as unknown as AgentSession;
  seam.state = "running";
  assert.throws(() => adapter.addQueuedPrompt("other", "x", "wrong conversation"), /not_found/);
  adapter.addQueuedPrompt("session-a", "1", "first follow-up");
  adapter.addQueuedPrompt("session-a", "2", "second follow-up");
  adapter.addQueuedPrompt("session-a", "3", "cancel me");
  seam.onPiEvent({ type: "agent_end", messages: [], willRetry: false });
  await tick();
  assert.equal(sent.length, 0, "agent_end must not dispatch before agent_settled");
  finish();
  await until(() => sent.length === 1);
  assert.deepEqual(sent, ["first follow-up"]);
  assert.equal(adapter.queueSnapshot().items[0]?.id, "2");
  adapter.controlQueue("session-a", true);
  adapter.editQueuedPrompt("session-a", "2", "edited second");
  adapter.removeQueuedPrompt("session-a", "3");
  await adapter.abort();
  await tick();
  assert.equal(sent.length, 1, "Stop must pause later messages");
  assert.equal(adapter.queueSnapshot().paused, true);
  adapter.controlQueue("session-a", false);
  await until(() => sent.length === 2);
  assert.deepEqual(sent, ["first follow-up", "edited second"]);
  adapter.addQueuedPrompt("session-a", "2", "duplicate after consumption");
  assert.equal(adapter.queueSnapshot().items.length, 0);
  const dispatched = events.filter((e) => e.type === "queue.dispatched");
  assert.equal(dispatched.length, 2);
  console.log("✓ one item per settled run, edit/cancel, Stop/resume, stale-session rejection and consumed-ID idempotency");

  adapter.addQueuedPrompt("session-a", "4", "preflight fails once");
  adapter.addQueuedPrompt("session-a", "5", "last queued message");
  rejectNext = true;
  finish();
  await until(() => adapter.queueSnapshot().paused);
  assert.equal(adapter.queueSnapshot().items[0]?.status, "failed");
  assert.equal(sent.length, 2, "preflight failure does not drain later items");
  adapter.controlQueue("session-a", false);
  await until(() => sent.length === 3);
  assert.equal(sent[2], "preflight fails once");
  seam.lastError = "model failed";
  finish();
  await until(() => adapter.getState() === "failed");
  assert.equal(adapter.queueSnapshot().paused, true);
  assert.equal(sent.length, 3, "runtime failure pauses queued work");
  console.log("✓ preflight rejection and model failure preserve and pause the queue");

  let release!: () => void;
  preflightGate = new Promise<void>((resolve) => { release = resolve; });
  adapter.controlQueue("session-a", false);
  await until(() => adapter.queueSnapshot().items[0]?.status === "sending");
  let stopped = false;
  const stop = adapter.abort().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, "Stop waits for in-flight preflight before aborting");
  release();
  await stop;
  await tick();
  assert.equal(adapter.getState(), "aborted");
  assert.equal(idle, true, "accepted late preflight cannot keep running after Stop");
  preflightGate = undefined;
  adapter.addQueuedPrompt("session-a", "6", "kept after disposal");
  await adapter.dispose();
  assert.equal(sent.length, 4);
  assert.equal(adapter.sessionId, "");
  console.log("✓ Stop/preflight race and disposal cannot start work after cancellation");
} finally { rmSync(root, { recursive: true, force: true }); }
