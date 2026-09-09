import assert from "node:assert/strict";
import { Store } from "../../apps/desktop/src/renderer/store.js";
import { conversationKey, loadConversationDrafts } from "../../apps/desktop/src/renderer/lib/conversation-drafts.js";
import { validateAgentPrompt } from "../../packages/shared/src/ipc/schemas.js";
import type { AgentSnapshot, Result } from "../../packages/shared/src/index.js";
import type { HelloAgentApi } from "../../apps/desktop/src/preload/index.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
} });
const snapshot = (id = "a", cwd = "/project"): AgentSnapshot => ({
  version: 1, lastSequence: 0, cwd, trust: "trusted", session: { id, file: undefined, name: undefined },
  agentState: "idle", messages: [], tools: [], activeToolPreviews: [], pendingApprovals: [],
  authState: { configured: true, provider: "test", maskedHint: null }, authProviders: [], models: [],
  selectedModel: null, contextUsage: null,
});
type Reply = Result<{ accepted: boolean }>;
let requests: Array<{ text: string; sessionId: string; resolve: (r: Reply) => void; reject: () => void }> = [];
(globalThis as unknown as { window: unknown }).window = { helloAgent: {
  agent: { prompt: (text: string, sessionId: string) => new Promise<Reply>((resolve, reject) => {
    requests.push({ text, sessionId, resolve, reject: () => reject(new Error("connection lost")) });
  }) },
} as unknown as HelloAgentApi };
const store = new Store();
store.applySnapshot(snapshot());
const draft = () => store.getState().drafts[store.draftKey()];

store.setDraft("  第一条消息\n原文  ");
const first = store.prompt("第一条消息\n原文");
await store.prompt("第一条消息\n原文");
assert.equal(requests.length, 1, "rapid submissions send only one IPC request");
assert.equal(requests[0]!.sessionId, "a");
store.setDraft("下一条草稿");
requests[0]!.resolve({ ok: true, data: { accepted: false } });
await first;
assert.equal(draft()?.pending?.text, "  第一条消息\n原文  ");
assert.equal(draft()?.text, "下一条草稿");
assert.equal(store.getState().entries.length, 0, "rejected optimistic bubble is removed");
assert.equal(draft()?.pending?.status, "failed");

const retry = store.retryPrompt();
await store.retryPrompt();
assert.equal(requests.length, 2, "double retry is locked synchronously");
assert.equal(store.getState().entries.length, 1);
requests[1]!.resolve({ ok: true, data: { accepted: true } });
await retry;
await store.retryPrompt();
assert.equal(requests.length, 2, "successful retry cannot run again");
assert.equal(draft()?.pending, undefined);
assert.equal(draft()?.text, "下一条草稿", "acceptance does not overwrite newer typing");
store.applySnapshot({ ...snapshot(), messages: [{ messageId: "persisted-user", role: "user", text: "第一条消息\n原文" }] });
assert.equal(store.getState().entries.length, 1, "snapshot reconciliation has no duplicate bubble");
console.log("✓ rejection, preserved original text, rapid submit/retry, acceptance and snapshot reconciliation");

store.applySnapshot(snapshot("b"));
assert.equal(draft(), undefined);
store.setDraft("B 的草稿");
store.applySnapshot(snapshot());
assert.equal(draft()?.text, "下一条草稿");
const late = store.prompt("下一条草稿");
store.applySnapshot(snapshot("b"));
requests[2]!.resolve({ ok: false, error: { code: "auth_required", message: "请配置服务商" } });
await late;
assert.equal(draft()?.text, "B 的草稿");
assert.equal(draft()?.pending, undefined, "late failure never lands in another conversation");
store.applySnapshot(snapshot());
assert.equal(draft()?.pending?.status, "failed");
store.setDraft("等待时写的新内容");
store.editFailedSend();
assert.equal(draft()?.text, "等待时写的新内容\n\n下一条草稿", "editing failure preserves existing draft");
assert.equal(draft()?.pending, undefined);
const restored = new Store();
restored.applySnapshot(snapshot("b"));
assert.equal(restored.getState().drafts[restored.draftKey()]?.text, "B 的草稿");
store.applySnapshot(snapshot("a", "/other"));
assert.equal(draft(), undefined, "project identity isolates identical session IDs");
console.log("✓ conversation/project isolation, late replies, edit recovery and persistence");

store.applySnapshot(snapshot("c"));
store.setDraft("不能重复执行的任务");
const uncertain = store.prompt("不能重复执行的任务");
const reloaded = new Store();
reloaded.applySnapshot(snapshot("c"));
assert.equal(reloaded.getState().drafts[reloaded.draftKey()]?.pending?.status, "uncertain");
await reloaded.retryPrompt();
assert.equal(requests.length, 4, "reload must never automatically retry an in-flight request");
requests[3]!.reject();
await uncertain;
assert.equal(draft()?.pending?.status, "uncertain");
await store.retryPrompt();
await store.prompt("不能重复执行的任务");
assert.equal(requests.length, 4, "ambiguous delivery blocks blind resend");
store.dismissFailedSend();
store.setDraft("明确丢弃后写的新内容");
assert.equal(draft()?.pending, undefined);
console.log("✓ uncertain IPC delivery and reload cannot duplicate a request");

assert.equal(validateAgentPrompt({ text: "hello" }).ok, false);
assert.equal(validateAgentPrompt({ text: "hello", sessionId: "a" }).ok, true);
assert.equal(validateAgentPrompt({ text: "hello", sessionId: "" }).ok, false);
for (const key of storage.keys()) storage.set(key, "{ broken");
assert.deepEqual(loadConversationDrafts(), {});
console.log("✓ required session ownership and corrupt-storage fallback");
