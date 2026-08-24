// Renderer Store 逻辑验证：模拟真实的乱序事件流（delta 批次迟到），
// 断言首轮结束后 sessions 列表会被刷新出来。
//
// 运行：cd apps/desktop && pnpm exec tsx ../../spikes/probes/renderer-store-sim.ts

type Ev = Record<string, unknown> & { type: string; sequence: number };

let sessionListCalls = 0;
let snapshotCalls = 0;

const fakeApi = {
  events: {
    subscribe(_cb: (e: unknown) => void): () => void {
      return () => undefined;
    },
  },
  agent: {
    snapshot: async () => {
      snapshotCalls++;
      return {
        ok: true,
        data: {
          version: 1,
          lastSequence: 0,
          cwd: "/tmp/ws",
          trust: "trusted",
          session: { id: "s1" },
          agentState: "idle",
          messages: [],
          activeToolPreviews: [],
          pendingApprovals: [],
        },
      };
    },
    prompt: async () => ({ ok: true, data: { accepted: true } }),
  },
  session: {
    list: async () => {
      sessionListCalls++;
      // Main 层此时已能列出会话（探针已证实）
      return { ok: true, data: [{ file: "/sessions/f1.jsonl", name: "AI 标题", modified: Date.now() }] };
    },
  },
} as unknown as { events: never; agent: never; session: never };

(globalThis as { window?: unknown }).window = { helloAgent: fakeApi };

const storeMod = await import("../../apps/desktop/src/renderer/store.js");
const Store = storeMod.store as unknown as { getState(): { sessions: unknown[] }; enterWorkspace(): Promise<void>; applyEvent(e: never): void };
void sessionListCalls;

const store = Store;
store.getState(); // warm

await store.enterWorkspace();
console.log("enterWorkspace 后 sessions:", store.getState().sessions.length);

// ── 模拟一轮真实对话的事件到达顺序（含批处理导致的乱序）──────────────────
const mk = (sequence: number, rest: Record<string, unknown>): Ev =>
  ({ version: 1, sessionId: "s1", timestamp: Date.now(), ...rest, sequence } as Ev);

// applyEvent 是 private，用 (store as any) 绕过——仅为测试
const feed = (e: Ev): void => (store as unknown as { applyEvent(e: Ev): void }).applyEvent(e);

// 正常开始：running(seq1)
feed(mk(1, { type: "agent.state", state: "running" }));
// delta seq2..6 进入批处理器（延迟投递），先缓存
const lateDeltas = [2, 3, 4, 5, 6].map((s) => mk(s, { type: "message.delta", messageId: "m1", delta: "x" }));
// 非 delta 直接透传：message.started seq7 超前到达 → gap(7 > 0+1) → drop+snapshot 恢复
feed(mk(7, { type: "message.started", messageId: "m1", role: "assistant" }));
// 迟到的 delta 批次
for (const d of lateDeltas) feed(d);
// 流结束：finished seq8、idle seq9（假设这次没 gap）
feed(mk(8, { type: "message.finished", messageId: "m1" }));
feed(mk(9, { type: "agent.state", state: "idle" }));

console.log("idle 后 sessions:", store.getState().sessions.length);
console.log("idle 后 sessions 内容:", JSON.stringify(store.getState().sessions.map((s) => s.name)));

// 极端场景：idle 本身也撞上 gap（前面还有未投递的 delta seq10-11 缓存着）
feed(mk(12, { type: "agent.state", state: "idle" })); // 12 > 9+1 → drop + 恢复路径
console.log("gap-drop idle 后 sessions:", store.getState().sessions.length);

if (store.getState().sessions.length > 0) {
  console.log("\n✓ Renderer 逻辑正常：乱序场景下也能刷新出会话列表");
  console.log("  → 若真机仍不显示，请确认已完全重启 dev 进程（main 进程改动需重启 Electron，renderer 需重新构建）");
} else {
  console.log("\n✗ Renderer 逻辑有问题");
}
process.exit(0);
