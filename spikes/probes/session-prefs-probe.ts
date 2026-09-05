// session-prefs — 权限模式/模型选择的继承契约：
// 新对话继承全局最后一次（跨项目）；切换会话/项目恢复该目录最后一次的选择；
// 偏好持久化，重启后仍生效。无需真实 LLM（models.json 注入 fake provider）。

import { mkdtempSync, mkdirSync, writeFileSync, renameSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import { SessionPrefsStore } from "../../apps/desktop/src/main/session-prefs.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";
import { validateThinkingSet, type AgentEvent } from "../../packages/shared/src/index.js";
import type { AgentSession } from "../../apps/desktop/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { store as rendererStore } from "../../apps/desktop/src/renderer/store.js";
import { exitOn, Reporter } from "./harness.js";

const r = new Reporter();
process.env.PI_OFFLINE = "1"; // fake provider 不可达：禁用目录网络刷新
await r.run("session-prefs", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-prefs-"));
  // 应用层（canonicalize）与 SessionPrefsStore 均用 realpath 后的路径做 key，
  // 探针同样先 realpath，避免 macOS /var → /private/var 不一致。
  mkdirSync(join(root, "project-a"), { recursive: true });
  mkdirSync(join(root, "project-b"), { recursive: true });
  const dirA = realpathSync(join(root, "project-a"));
  const dirB = realpathSync(join(root, "project-b"));
  for (const d of [dirA, dirB]) mkdirSync(d, { recursive: true });

  const appData = join(root, "appdata");
  const agentDir = join(appData, "pi-agent");
  const paths = {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });
  // fake provider：静态 apiKey → checkAuth 同步判定 configured，无需网络。
  writeFileSync(
    paths.modelsPath,
    JSON.stringify({
      providers: {
        fakeprov: {
          name: "Fake Provider",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "sk-fake-probe",
          api: "openai-completions",
          models: [
            { id: "fake-model", name: "Fake Model", reasoning: true, contextWindow: 8192, maxTokens: 4096 },
            { id: "fake-model-2", name: "Fake Model 2", contextWindow: 8192, maxTokens: 4096 },
          ],
        },
      },
    }),
  );
  const prefsFile = join(appData, "session-prefs.json");
  const prefs = new SessionPrefsStore(prefsFile);

  const events: AgentEvent[] = [];
  let cwd = dirA;
  let trust: "untrusted" | "restricted" | "trusted" = "trusted";
  const host: AgentHost = {
    paths,
    getCwd: () => cwd,
    getTrust: () => trust,
    emit: (e: AgentEvent) => { events.push(e); },
    getEnvKey: () => undefined,
    moveToTrash: async (p: string) => { renameSync(p, `${p}.trashed`); return true; },
  };
  const mkPermissions = () =>
    new PermissionManager({
      getTrust: () => trust,
      getCwd: () => cwd,
      getSessionId: () => adapter.sessionId,
      onApprovalRequested: () => {},
      onApprovalResolved: () => {},
      audit: () => {},
    });
  let permissions = mkPermissions();
  let adapter = new PiAdapter(host, permissions, { prefs });
  const model = () => {
    const m = (adapter as unknown as { session?: { model?: { provider: string; id: string } } }).session?.model;
    return m ? `${m.provider}/${m.id}` : null;
  };

  // ── A：初始状态 + 记录偏好 ──────────────────────────────────────────────
  await adapter.create(dirA);
  r.check("初始权限模式为 default", permissions.getMode() === "default");

  await adapter.selectModel("fakeprov/fake-model");
  r.check("selectModel 生效", model() === "fakeprov/fake-model", model() ?? "null");
  r.check("selectModel 记录全局 last", JSON.stringify(prefs.getLast()) === JSON.stringify({ permissionMode: "default", model: "fakeprov/fake-model", thinkingLevel: adapter.thinkingConfig().thinkingLevel }), JSON.stringify(prefs.getLast()));
  r.check("selectModel 记录项目 A", !!prefs.getForProject(dirA));

  r.check("IPC 拒绝非法强度", !validateThinkingSet({ level: "ultra" }).ok);
  r.check("IPC 接受 high", validateThinkingSet({ level: "high" }).ok);
  r.check("推理模型提供 high 档位", adapter.thinkingConfig().thinkingLevels.includes("high"));
  adapter.setThinkingLevel("high");
  r.check("设置强度生效并持久化", adapter.thinkingConfig().thinkingLevel === "high" && prefs.getLast()?.thinkingLevel === "high");

  adapter.setPermissionMode("full");
  r.check("setPermissionMode(full) 生效并记录", permissions.getMode() === "full" && prefs.getLast()?.permissionMode === "full");

  // ── 新对话继承最后一次（权限 + 模型）────────────────────────────────────
  await adapter.newSession();
  r.check("新对话继承权限模式 full", permissions.getMode() === "full", permissions.getMode());
  r.check("新对话继承思考强度", adapter.thinkingConfig().thinkingLevel === "high");
  r.check("新对话继承模型", model() === "fakeprov/fake-model", model() ?? "null");

  // 换模型后再新对话：继承的是最新的选择
  await adapter.selectModel("fakeprov/fake-model-2");
  r.check("非推理模型仅支持 off", JSON.stringify(adapter.thinkingConfig().thinkingLevels) === '["off"]' && adapter.thinkingConfig().thinkingLevel === "off");
  let rejected = false;
  try { adapter.setThinkingLevel("high"); } catch { rejected = true; }
  r.check("拒绝模型不支持的档位", rejected && adapter.thinkingConfig().thinkingLevel === "off");
  await adapter.newSession();
  r.check("新对话继承最新模型", model() === "fakeprov/fake-model-2", model() ?? "null");

  // ── 切换会话：目录记忆覆盖会话文件里的旧模型 ────────────────────────────
  await seed(adapter);
  const fileA = adapter.sessionFilePath();
  r.check("会话文件已落盘", !!fileA);
  // 当前会话文件记录的模型是 fake-model-2；把目录记忆换成 fake-model，
  // 再切走切回：应恢复目录记忆的 fake-model，而不是文件里的 fake-model-2。
  await adapter.selectModel("fakeprov/fake-model");
  await adapter.newSession();
  await adapter.openSession(fileA!);
  r.check("切换会话恢复目录记忆的权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("切换会话恢复目录记忆的模型（覆盖文件旧值）", model() === "fakeprov/fake-model", model() ?? "null");

  // ── 切换项目：B 无记忆 → 沿用（继承最后一次对话）；有记忆 → 恢复记忆 ────
  cwd = dirB;
  await adapter.create(dirB);
  r.check("切到新项目沿用权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("切到新项目沿用模型", model() === "fakeprov/fake-model", model() ?? "null");
  r.check("切到新项目后记录了 B 的记忆", !!prefs.getForProject(dirB));

  // B 里改成 default + fake-model-2 → A 的记忆不受影响
  adapter.setPermissionMode("default");
  await adapter.selectModel("fakeprov/fake-model-2");
  cwd = dirA;
  await adapter.create(dirA);
  r.check("切回 A 恢复 A 的权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("切回 A 恢复 A 的模型", model() === "fakeprov/fake-model", model() ?? "null");

  adapter.setThinkingLevel("high");

  // ── 重启恢复：重建 store/manager/adapter，从磁盘偏好恢复 ────────────────
  await adapter.dispose();
  const prefs2 = new SessionPrefsStore(prefsFile);
  permissions = mkPermissions();
  adapter = new PiAdapter(host, permissions, { prefs: prefs2 });
  await adapter.create(dirA);
  r.check("重启后恢复 A 的权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("重启后恢复思考强度 high", adapter.thinkingConfig().thinkingLevel === "high");
  r.check("重启后恢复 A 的模型", model() === "fakeprov/fake-model", model() ?? "null");

  // ── restricted 工作区：不恢复「完全访问」────────────────────────────────
  trust = "restricted";
  await adapter.create(dirA);
  r.check("restricted 工作区不恢复 full", permissions.getMode() === "default", permissions.getMode());
  trust = "trusted";

  // ── 持久化文件内容 sanity ────────────────────────────────────────────────
  const raw = JSON.parse(readFileSync(prefsFile, "utf8")) as { last?: unknown; projects?: unknown };
  r.check("prefs 文件含 last 与 projects", !!raw.last && typeof raw.projects === "object");

  // Context occupancy comes from Pi's current branch, never summed billing usage.
  const session = (adapter as unknown as { session: AgentSession }).session;
  const assistant = {
    role: "assistant" as const, content: [{ type: "text" as const, text: "context fixture" }],
    api: "openai-completions" as const, provider: "fakeprov", model: "fake-model",
    usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 200, totalTokens: 1800,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const, timestamp: Date.now(),
  };
  session.agent.state.messages = [assistant];
  const entryId = session.sessionManager.appendMessage(assistant);
  r.check("上下文包含输入输出与缓存 token", adapter.contextUsage()?.tokens === 1800);
  r.check("上下文百分比使用当前模型窗口", adapter.contextUsage()?.percent === 1800 / 8192 * 100);
  r.check("快照包含上下文用量", adapter.buildSnapshot([]).contextUsage?.tokens === 1800);
  session.sessionManager.appendCompaction("summary", entryId, 1800);
  r.check("压缩后用量未知而不是零", adapter.contextUsage()?.tokens === null && adapter.contextUsage()?.percent === null);
  r.check("压缩后仍保留窗口上限", adapter.contextUsage()?.contextWindow === 8192);
  // The adapter defers usage reads until Pi has persisted the message.
  (adapter as unknown as { onPiEvent(e: unknown): void }).onPiEvent({ type: "message_end", message: assistant });
  session.sessionManager.appendMessage(assistant);
  await Promise.resolve();
  const usageEvent = events.filter((e) => e.type === "context.usage").at(-1);
  r.check("消息落盘后推送新用量", usageEvent?.type === "context.usage" && usageEvent.usage?.tokens === 1800);
  const drive = adapter as unknown as { onPiEvent(e: unknown): void; modelSwitch?: Promise<void> };
  drive.onPiEvent({ type: "agent_start" });
  const originalModel = adapter.modelSelection().selected;
  const queued = await adapter.requestModel("fakeprov/fake-model-2");
  r.check("运行中切换排队，当前模型不变", queued.pendingModel === "fakeprov/fake-model-2" && queued.selected === originalModel);
  r.check("快照保留待切换模型", adapter.buildSnapshot([]).pendingModel === queued.pendingModel);
  drive.onPiEvent({ type: "agent_end", willRetry: true });
  r.check("agent_end 不提前切换或结束运行", adapter.getState() === "running" && adapter.modelSelection().selected === originalModel);
  await adapter.requestModel(originalModel!);
  r.check("选回当前模型取消排队", adapter.modelSelection().pendingModel === null);
  await adapter.requestModel("fakeprov/fake-model-2");
  drive.onPiEvent({ type: "agent_settled" });
  await drive.modelSwitch;
  r.check("本轮结束后才切换", adapter.modelSelection().selected === "fakeprov/fake-model-2" && adapter.modelSelection().pendingModel === null);
  r.check("切换后同步思考强度", adapter.thinkingConfig().thinkingLevel === "off");
  r.check("发出切换成功事件", events.some((e) => e.type === "model.selection" && !e.error && e.selection.selected === "fakeprov/fake-model-2"));
  r.check("切换完毕恢复空闲", adapter.getState() === "idle");
  drive.onPiEvent({ type: "agent_start" });
  await adapter.requestModel(originalModel!);
  const setModel = session.setModel;
  session.setModel = async () => { throw new Error("fixture auth failure"); };
  drive.onPiEvent({ type: "agent_settled" });
  await drive.modelSwitch;
  session.setModel = setModel;
  r.check("延迟切换失败保留旧模型并提示", adapter.modelSelection().selected === "fakeprov/fake-model-2" && events.some((e) => e.type === "model.selection" && !!e.error));
  // Reopening a populated session must resume the same IDs used by snapshots.
  await adapter.openSession(adapter.sessionFilePath()!);
  await adapter.selectModel(originalModel!);
  const resumed = (adapter as unknown as { session: AgentSession }).session;
  const renderer = rendererStore as unknown as {
    applyEvent(e: unknown): void;
    state: { entries: Array<{ kind: string; messageId?: string; text?: string }> };
  };
  rendererStore.applySnapshot(adapter.buildSnapshot([]));
  for (const level of ["off", "high"] as const) {
    adapter.setThinkingLevel(level);
    const before = adapter.buildSnapshot([]).messages.filter((m) => m.role === "assistant").length;
    const offset = events.length;
    const reply = { ...assistant, content: [{ type: "text" as const, text: "同一句回复" }], timestamp: Date.now() };
    drive.onPiEvent({ type: "message_start", message: reply });
    drive.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "同一句回复" } });
    await adapter.flush();
    resumed.sessionManager.appendMessage(reply);
    drive.onPiEvent({ type: "message_end", message: reply });
    await Promise.resolve();
    for (const event of events.slice(offset)) renderer.applyEvent(event);
    const snapshot = adapter.buildSnapshot([]);
    const start = events.slice(offset).find((e) => e.type === "message.started");
    const saved = snapshot.messages.filter((m) => m.role === "assistant").at(-1);
    r.check(`${level}: 恢复后的流式 ID 与落盘 ID 一致`, start?.type === "message.started" && start.messageId === saved?.messageId);
    rendererStore.applySnapshot(snapshot);
    rendererStore.applySnapshot(snapshot);
    const ids = renderer.state.entries.filter((e) => e.kind === "message" && e.messageId?.includes(":m:"));
    r.check(`${level}: 多次快照合并不重复回复`, ids.length === before + 1 && new Set(ids.map((e) => e.messageId)).size === ids.length);
    if (start) renderer.applyEvent({ ...start, sequence: undefined });
    r.check(`${level}: 重放开始事件不重复插入`, renderer.state.entries.filter((e) => e.kind === "message" && e.messageId === saved?.messageId).length === 1);
  }
  r.check("内容相同的两轮真实回复仍各自保留", renderer.state.entries.filter((e) => e.text === "同一句回复").length === 2);
  await adapter.dispose();
  r.check("关闭运行时清除用量", adapter.contextUsage() === null);
  r.check("dispose 完成无挂起", true);
}

/** Append one user message without needing an LLM so pi flushes the JSONL. */
async function seed(adapter: PiAdapter): Promise<void> {
  const t = setTimeout(() => void adapter.abort().catch(() => {}), 3_000);
  try {
    await adapter.prompt("seed");
  } catch {
    /* expected without a real endpoint */
  } finally {
    await adapter.abort();
    clearTimeout(t);
  }
}
