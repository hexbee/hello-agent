import assert from "node:assert/strict";
import type { AgentSnapshot, AgentEvent, PromptQueueSnapshot, Result } from "@hello-agent/shared";
import { Store } from "../../apps/desktop/src/renderer/store.js";
import type { HelloAgentApi } from "../../apps/desktop/src/preload/index.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
} });
const snap = (id = "a", queue?: PromptQueueSnapshot): AgentSnapshot => ({
  version: 1, lastSequence: 0, cwd: "/project", trust: "trusted", session: { id, file: undefined, name: undefined },
  agentState: "running", messages: [], tools: [], activeToolPreviews: [], pendingApprovals: [],
  authState: { configured: true, provider: "test", maskedHint: null }, authProviders: [], models: [],
  selectedModel: null, contextUsage: null, forkCandidates: [], promptQueue: queue,
});
let calls: Array<{ sessionId: string; id: string; text: string; resolve: (r: Result<PromptQueueSnapshot>) => void; reject: () => void }> = [];
let directCalls = 0;
(globalThis as unknown as { window: unknown }).window = { helloAgent: {
  agent: {
    prompt: async () => { directCalls++; return { ok: true, data: { accepted: true } }; },
    snapshot: async () => ({ ok: true, data: snap() }),
    queue: { add: (sessionId: string, id: string, text: string) => new Promise<Result<PromptQueueSnapshot>>((resolve, reject) => {
      calls.push({ sessionId, id, text, resolve, reject: () => reject(new Error("lost reply")) });
    }) },
  },
  session: { list: async () => ({ ok: true, data: [] }) },
  projects: { sessions: async () => ({ ok: true, data: [] }) },
} as unknown as HelloAgentApi };
const store = new Store();
store.applySnapshot(snap());
store.setDraft("next task");
const enqueue = store.submitPrompt("next task");
await store.submitPrompt("next task");
assert.equal(calls.length, 1);
assert.equal(directCalls, 0, "running submits only use the queue IPC");
assert.equal(store.getState().entries.length, 0, "waiting messages aren't premature chat bubbles");
store.setDraft("new typing while adding");
const q: PromptQueueSnapshot = { revision: 4, paused: false, items: [{ id: calls[0]!.id, text: "next task", status: "queued", createdAt: 1 }] };
calls[0]!.resolve({ ok: true, data: q });
await enqueue;
assert.equal(store.getState().drafts[store.draftKey()]?.text, "new typing while adding");
assert.equal(store.getState().promptQueue.items.length, 1);
store.applySnapshot(snap("a", { ...q, revision: 2, items: [] }));
assert.equal(store.getState().promptQueue.items.length, 1, "stale snapshots can't roll back queue updates");

const emit = (event: AgentEvent) => (store as unknown as { applyEvent(e: AgentEvent): void }).applyEvent(event);
const dispatch: AgentEvent = { version: 1, sequence: 3, sessionId: "a", timestamp: 1, type: "queue.dispatched", id: calls[0]!.id, text: "next task" };
emit(dispatch); // Deliberate gap: dispatch must survive delta reordering.
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(store.getState().entries.length, 1);
store.applySnapshot({ ...snap("a", q), messages: [{ messageId: "persisted", role: "user", text: "next task" }] });
emit(dispatch);
assert.equal(store.getState().entries.length, 1, "replayed dispatch after snapshot pairing must not duplicate a bubble");
console.log("✓ running enqueue, rapid submission, new draft preservation, revision ordering and dispatched bubble reconciliation");

store.setDraft("uncertain addition");
const uncertain = store.submitPrompt("uncertain addition");
calls[1]!.reject();
await uncertain;
assert.equal(store.getState().drafts[store.draftKey()]?.pending?.status, "uncertain");
const retry = store.retryPrompt();
assert.equal(calls[2]!.id, calls[1]!.id, "queue retries reuse the ID even when the acknowledgement was lost");
calls[2]!.resolve({ ok: true, data: { revision: 8, paused: false, items: [] } });
await retry;
assert.equal(store.getState().drafts[store.draftKey()]?.pending, undefined);

store.setDraft("late reply");
const late = store.submitPrompt("late reply");
store.applySnapshot(snap("b"));
calls[3]!.resolve({ ok: true, data: q });
await late;
assert.equal(store.getState().promptQueue.items.length, 0, "late A reply can't change B's queue");
assert.equal(store.getState().drafts[JSON.stringify(["/project", "a"])]?.pending, undefined);
console.log("✓ stable retry identity and late replies isolated to the originating conversation");
