// PiAdapter — the v0.1 AgentRuntime implementation. §5
//
// Electron-free by design: all environment specifics arrive via AgentHost, so
// spikes/probes can drive the exact same code headlessly.

import {
  createAgentSessionRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  AgentSnapshot,
  SafePreview,
} from "@hello-agent/shared";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { DeltaBatcher } from "./delta-batcher.js";
import {
  canonicalize,
  safePreview,
  type AgentHost,
} from "./host.js";
import { PermissionManager } from "./permission-manager.js";
import { createIsolatedModelRuntime, makeServicesFactory } from "./isolation.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type AgentState = "idle" | "running" | "aborted" | "failed";

export class PiAdapter {
  private runtime: AgentSessionRuntime | undefined;
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private modelRuntime: ModelRuntime | undefined;
  /** create() 时锁定的 canonical cwd；SessionManager.list 的 cwd 过滤是纯字符串比较，
   * 必须与写入 session header 的值逐字一致（pi 的 resolvePath 不做 realpath）。 */
  private canonicalCwd: string | undefined;
  private batcher: DeltaBatcher;
  private sequence = 0;
  private state: AgentState = "idle";
  private assistantOrdinal = 0;
  private activeMessageId: string | undefined;
  /** toolCallIds currently executing (for snapshot previews). */
  private activeTools = new Map<string, { name: string; preview: SafePreview }>();
  /** SessionIds whose auto-title was already attempted (success or not). */
  private titleAttempted = new Set<string>();
  private lastError: string | undefined;
  /** §4.5 watchdog: armed while running, reset on every pi event. */
  private watchdogTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly host: AgentHost,
    readonly permissions: PermissionManager,
    /** Probe seam: additional inline extensions (e.g. hang injection). */
    private opts: { extraExtensions?: InlineExtension[] } = {},
  ) {
    this.batcher = new DeltaBatcher((events) => {
      for (const e of events) this.emit(e);
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  get sessionId(): string {
    return this.session?.sessionId ?? "";
  }

  async create(cwdInput: string): Promise<{ cwd: string }> {
    const cwd = canonicalize(cwdInput);
    if (!cwd) throw new Error(`cannot canonicalize cwd: ${cwdInput}`);
    this.canonicalCwd = cwd;

    await this.disposeInternal({ abortFirst: false });

    if (!this.modelRuntime) {
      this.modelRuntime = await createIsolatedModelRuntime(this.host.paths);
      // Spike auth policy: env-injected keys via runtime overrides (never persisted).
      const key = this.host.getEnvKey("anthropic");
      if (key) await this.modelRuntime.setRuntimeApiKey("anthropic", key);
    }

    const permissionExtension: { name: string; factory: ExtensionFactory } = {
      name: "permission-manager",
      factory: this.permissions.factory,
    };

    const factory = makeServicesFactory({
      paths: this.host.paths,
      modelRuntime: this.modelRuntime,
      permissionExtension,
      trust: this.host.getTrust(),
      extraExtensions: this.opts.extraExtensions,
    });

    this.runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: this.host.paths.agentDir,
      sessionManager: SessionManager.create(cwd, this.host.paths.sessionsDir),
    });

    for (const d of this.runtime.diagnostics ?? []) {
      if (d.type === "error") console.warn("[pi-adapter] diagnostic:", d.message);
    }

    this.assistantOrdinal = 0;
    await this.bindCurrentSession();
    this.disarmWatchdog();
    return { cwd };
  }

  /**
   * §5.2 binding flow — unsubscribe → bindExtensions(actualBindings) → subscribe.
   * Must run after every session replacement (new/switch/fork).
   */
  private async bindCurrentSession(): Promise<void> {
    this.unsubscribe?.();
    const session = this.session = this.runtime!.session;
    await session.bindExtensions({
      abortHandler: () => void this.permissions.cancelAll("agent abort"),
    });
    this.unsubscribe = session.subscribe((event) => this.onPiEvent(event));
  }

  async dispose(): Promise<void> {
    await this.disposeInternal({ abortFirst: true });
  }

  private async disposeInternal(opts: { abortFirst: boolean }): Promise<void> {
    if (opts.abortFirst && this.state === "running") {
      try {
        await withTimeout(this.session?.abort() ?? Promise.resolve(), 3_000);
      } catch {
        /* §4.5: every step has a timeout fallback */
      }
    }
    this.disarmWatchdog();
    this.permissions.cancelAll("runtime dispose");
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session = undefined;
    await this.batcher.dispose();
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime) {
      try {
        await withTimeout(Promise.resolve(runtime.dispose()), 3_000);
      } catch (e) {
        console.warn("[pi-adapter] dispose timeout/error:", e);
      }
    }
    this.state = "idle";
  }

  /**
   * §4.5 explicit rebuild: dispose the broken runtime, re-check cwd/auth,
   * recreate bindings and restore the most recent usable JSONL session.
   */
  async rebuild(): Promise<{ sessionId: string; restoredSessionId: string | null }> {
    const cwd = this.host.getCwd();
    if (!cwd) throw new Error("no_runtime: no workspace");
    await this.disposeInternal({ abortFirst: true });
    await this.create(cwd); // re-canonicalizes cwd + re-binds extensions
    let restored: string | null = null;
    try {
      const sessions = (await this.listSessions())
        .filter((s) => s.file)
        .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
      const latest = sessions[0];
      if (latest?.file) {
        await this.openSession(latest.file);
        restored = this.sessionId || null;
      }
    } catch {
      // No restorable session — stay on the fresh session created by create().
    }
    return { sessionId: this.sessionId, restoredSessionId: restored };
  }

  // ── watchdog (§4.5 / ADR: agent stalled → failed + abort) ─────────────────

  private armWatchdog(): void {
    const ms = this.host.watchdogTimeoutMs;
    if (!ms || ms <= 0) return;
    this.disarmWatchdog();
    this.watchdogTimer = setTimeout(() => void this.onWatchdogFired(), ms);
  }

  private bumpWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearTimeout(this.watchdogTimer);
    const ms = this.host.watchdogTimeoutMs ?? 0;
    if (ms > 0) this.watchdogTimer = setTimeout(() => void this.onWatchdogFired(), ms);
  }

  private disarmWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private async onWatchdogFired(): Promise<void> {
    if (this.state !== "running") return;
    const ms = this.host.watchdogTimeoutMs ?? 0;
    this.state = "failed";
    this.lastError = `watchdog: no agent activity for ${ms}ms`;
    this.emit(
      this.mk("agent.failed", { kind: "runtime", message: `agent stalled (no activity for ${Math.round(ms / 1000)}s)` }),
    );
    this.emit(this.mk("agent.state", { state: "failed" }));
    try {
      await withTimeout(this.session?.abort() ?? Promise.resolve(), 3_000);
    } catch {
      /* abort timeout — runtime rebuild is the recovery path */
    }
  }

  // ── run ────────────────────────────────────────────────────────────────────

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("no_runtime: workspace not open");
    return this.session;
  }
  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("no_runtime: workspace not open");
    return this.runtime;
  }

  /** Resolves after preflight acceptance; full run continues in background events.
   * 注意：pi 的 session.prompt() 要等整轮 run 结束才 resolve，preflightResult
   * 只是旁路回调——绝不能 await 它，否则 renderer 的用户气泡会被拖到回复之后。 */
  async prompt(text: string): Promise<{ accepted: boolean }> {
    const session = this.requireSession();
    return new Promise<{ accepted: boolean }>((resolve) => {
      let settled = false;
      const finish = (accepted: boolean) => {
        if (!settled) {
          settled = true;
          resolve({ accepted });
        }
      };
      const p = session.prompt(text, {
        preflightResult: (ok) => finish(ok),
      });
      // preflight 未触发 promise 就先结算（如运行前错误）：兑底，避免 IPC 挂起。
      // 运行期错误经 agent.failed / agent.state 事件传递，不在这里等。
      void p.then(
        () => finish(false),
        () => finish(false),
      );
    });
  }

  async abort(): Promise<void> {
    const session = this.requireSession();
    this.permissions.cancelAll("user abort");
    await session.abort();
    this.state = "aborted";
  }

  getState(): AgentState {
    return this.state;
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  async listSessions(): Promise<Array<{ file: string; name?: string; modified?: number }>> {
    // 用 create() 时锁定的 canonical cwd，而不是 host.getCwd() 的即时值：
    // 若两者字符串不一致，pi 会按 cwd 过滤掉全部会话。
    const cwd = this.canonicalCwd ?? canonicalize(this.host.getCwd());
    if (!cwd) return [];
    const infos = await SessionManager.list(cwd, this.host.paths.sessionsDir);
    return infos.map((i) => ({
      file: i.path ?? "",
      name: (i as { name?: string }).name,
      modified: (i as { modified?: number | string | Date }).modified as number | undefined,
    }));
  }

  async openSession(pathInput: string): Promise<{ sessionId: string }> {
    const runtime = this.requireRuntime();
    // Only sessions inside OUR dir are openable (delete/open share this rule). §5.3
    const real = this.ensureOwnSessionFile(pathInput);
    await this.replaceSession(() => runtime.switchSession(real));
    return { sessionId: this.sessionId };
  }

  async newSession(): Promise<{ sessionId: string }> {
    const runtime = this.requireRuntime();
    await this.replaceSession(() => runtime.newSession());
    return { sessionId: this.sessionId };
  }

  async forkSession(entryId: string): Promise<{ sessionId: string }> {
    const runtime = this.requireRuntime();
    await this.replaceSession(() => runtime.fork(entryId));
    return { sessionId: this.sessionId };
  }

  renameSession(name: string): void {
    const session = this.requireSession();
    session.setSessionName(name);
    this.emit(this.mk("session.renamed", { name: session.sessionName ?? name }));
  }

  /**
   * 首轮对话结束后，用当前会话的模型为会话生成一个短标题并持久化
   * （appendSessionInfo 条目）。只对未命名且从未尝试过的会话执行一次；
   * 失败静默，手动改名仍可用。
   */
  private async autoTitleSession(): Promise<void> {
    const session = this.session;
    const rt = this.modelRuntime;
    if (!session || !rt) return;
    if (session.sessionName || this.titleAttempted.has(session.sessionId)) return;
    const users = session.getUserMessagesForForking();
    const first = users[0]?.text?.trim();
    if (!first || users.length === 0) return; // 没有用户消息就没有可总结的内容
    this.titleAttempted.add(session.sessionId);
    try {
      const model = session.model ?? rt.getAvailableSnapshot()[0];
      if (!model) return;
      const prompt =
        `为下面的用户请求起一个简短的中文标题（不超过16个字），` +
        `直接输出标题本身，不要引号、句号或任何其他文字：\n\n${first.slice(0, 800)}`;
      const res = await withTimeout(
        rt.completeSimple(model, {
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        } satisfies Context),
        20_000,
      );
      // 仍绑定同一会话才写入，避免竞态下改错会话
      if (this.session !== session) return;
      const title = extractText(res)
        .split("\n")[0]!
        .replace(/^[\s"'“”「」]+|[\s"'“”「」。]+$/g, "")
        .slice(0, 40)
        .trim();
      if (!title) return;
      session.setSessionName(title);
      this.emit(this.mk("session.renamed", { name: title }));
    } catch {
      /* 起标题是尽力而为：失败不影响主流程 */
    }
  }

  async deleteSession(pathInput: string): Promise<void> {
    const real = this.ensureOwnSessionFile(pathInput);
    // §1.3 可恢复删除: trash first; permanent unlink only if trash fails.
    const trashed = await this.host.moveToTrash(real).catch(() => false);
    if (!trashed) {
      const { unlink } = await import("node:fs/promises");
      await unlink(real);
    }
  }

  /** §7.2 / §4.1: cancel approvals BEFORE replacing the live session. */
  private async replaceSession(replace: () => Promise<unknown>): Promise<void> {
    this.permissions.cancelAll("session replacement");
    this.permissions.resetSessionRules();
    try {
      await withTimeout(this.session?.abort() ?? Promise.resolve(), 3_000);
    } catch {
      /* timeout fallback */
    }
    await replace();
    this.assistantOrdinal = 0;
    this.activeTools.clear();
    await this.bindCurrentSession();
  }

  // ── models & auth ──────────────────────────────────────────────────────────

  /** Provider auth capabilities for the auth dialog. No secrets. */
  listAuthProviders(): AgentSnapshot["authProviders"] {
    const rt = this.requireModelRuntime();
    return rt.getProviders().map((p) => ({
      id: p.id,
      name: p.name,
      supportsApiKey: p.auth?.apiKey != null,
      supportsOAuth: p.auth?.oauth != null,
      configured: rt.hasConfiguredAuth(p.id),
    }));
  }

  /** §8.2 — store the key, then VERIFY it resolves auth + yields models. */
  async submitApiKey(providerId: string, apiKey: string): Promise<void> {
    const rt = this.requireModelRuntime();
    if (!rt.getProvider(providerId)) throw new Error(`not_found: unknown provider ${providerId}`);
    await rt.setRuntimeApiKey(providerId, apiKey); // writes through CredentialStore
    try {
      const check = await withTimeout(rt.checkAuth(providerId), 10_000);
      if (!check) throw new Error("auth check failed");
      const available = await withTimeout(rt.getAvailable(providerId), 15_000);
      if (available.length === 0) throw new Error("no models available for this key");
    } catch (e) {
      // §8.3: invalid key → roll back; never keep a half-configured state.
      await rt.removeRuntimeApiKey(providerId).catch(() => undefined);
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`auth_required: ${msg}`);
    }
  }

  private requireModelRuntime(): ModelRuntime {
    if (!this.modelRuntime) throw new Error("no_runtime: workspace not open");
    return this.modelRuntime;
  }


  async listModels(): Promise<AgentSnapshot["models"]> {
    if (!this.modelRuntime) throw new Error("no_runtime: workspace not open");
    const available = await this.modelRuntime.getAvailable();
    return available.slice(0, 200).map((m) => ({
      provider: m.provider ?? "",
      id: m.id,
      context: m.contextWindow ?? null,
    }));
  }

  async selectModel(ref: string): Promise<string | null> {
    const session = this.requireSession();
    if (this.state === "running") throw new Error("busy: agent running");
    const [provider, id] = ref.split("/");
    const model: Model<Api> | undefined =
      provider && id ? this.modelRuntime!.getModel(provider, id) : undefined;
    if (!model) throw new Error(`model not found: ${ref}`);
    await session.setModel(model);
    return `${model.provider}/${model.id}`;
  }

  async authState(): Promise<AgentSnapshot["authState"]> {
    if (!this.modelRuntime) {
      return { configured: false, provider: null, maskedHint: null };
    }
    const providers = this.modelRuntime.getProviders().filter((p) =>
      this.modelRuntime!.hasConfiguredAuth(p.id),
    );
    const provider = providers[0]?.id ?? null;
    if (!provider) {
      return { configured: false, provider: null, maskedHint: null };
    }
    // Persisted credential hint first; env key as dev fallback. Never raw keys.
    const meta = this.host.credentialMeta?.(provider);
    const maskedHint =
      meta?.maskedHint ?? maskKey(this.host.getEnvKey(provider));
    return { configured: true, provider, maskedHint };
  }

  // ── dev-only stress hook (real emit path, no LLM) ──────────────────────────

  injectDevDeltas(count: number, sizeBytes: number): void {
    const chunk = "x".repeat(sizeBytes);
    const messageId = `${this.sessionId}:stress`;
    void (async () => {
      this.emit(this.mk("message.started", { messageId, role: "assistant" }));
      for (let i = 0; i < count; i++) {
        this.batcher.push(this.mk("message.delta", { messageId, delta: chunk }));
        // Yield long enough for the batcher's flush window to fire so we
        // measure steady-state throughput, not queue saturation.
        if (i % 1_000 === 999) await new Promise((r) => setTimeout(r, 25));
        else if (i % 100 === 99) await new Promise((r) => setImmediate(r));
      }
      await this.batcher.flush();
      this.emit(this.mk("message.finished", { messageId }));
    })();
  }

  batcherStats(): DeltaBatcher["stats"] {
    return { ...this.batcher.stats };
  }

  /** Drain any queued deltas (probe/test seam). */
  async flush(): Promise<void> {
    await this.batcher.flush();
  }

  // ── event normalization ────────────────────────────────────────────────────

  private mk(type: AgentEvent["type"], rest: Record<string, unknown>): AgentEvent {
    return {
      version: 1,
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...rest,
      type,
    } as AgentEvent;
  }

  private emit(event: AgentEvent): void {
    // Delta events reach here only via batcher flush batches (already ordered).
    this.host.emit(event);
  }

  /** §7.2 — PermissionManager 回调经此发事件，复用统一 sequence 计数器。 */
  emitApprovalRequested(pending: {
    requestId: string;
    toolCallId: string;
    toolName: string;
    displayInput: SafePreview;
  }): void {
    this.emit(
      this.mk("approval.requested", {
        requestId: pending.requestId,
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        displayInput: pending.displayInput,
      }),
    );
  }

  emitApprovalResolved(
    requestId: string,
    decision: "allow" | "allow-once" | "deny" | "cancelled" | "expired",
  ): void {
    this.emit(this.mk("approval.resolved", { requestId, decision }));
  }

  private synthMessageId(): string {
    return `${this.sessionId}:m:${++this.assistantOrdinal}`;
  }

  private onPiEvent(event: AgentSessionEvent): void {
    // Any pi activity proves the pipeline is alive.
    this.bumpWatchdog();
    switch (event.type) {
      case "message_start": {
        const role = (event.message as { role?: string }).role;
        if (role !== "assistant") break;
        this.activeMessageId = this.synthMessageId();
        this.emit(this.mk("message.started", { messageId: this.activeMessageId!, role: "assistant" }));
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (!this.activeMessageId) break;
        if (ame.type === "text_delta" || ame.type === "thinking_delta") {
          this.batcher.push(
            this.mk(ame.type === "text_delta" ? "message.delta" : "thinking.delta", {
              messageId: this.activeMessageId,
              delta: ame.delta,
            }),
          );
        }
        break;
      }
      case "message_end": {
        if ((event.message as { role?: string }).role !== "assistant") break;
        if (this.activeMessageId) {
          this.emit(this.mk("message.finished", { messageId: this.activeMessageId }));
          this.activeMessageId = undefined;
        }
        break;
      }
      case "tool_execution_start": {
        this.activeTools.set(event.toolCallId, {
          name: event.toolName,
          preview: safePreview(event.args),
        });
        this.emit(
          this.mk("tool.started", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            inputPreview: safePreview(event.args),
          }),
        );
        break;
      }
      case "tool_execution_update": {
        // 与 tool_execution_end 一致：取 text 块纯文本，避免工具卡输出
        // 显示 {"content":[{"type":"text",...}]} 原始 JSON。
        const partialText = extractText(event.partialResult);
        this.activeTools.set(event.toolCallId, {
          name: event.toolName,
          preview: safePreview(partialText),
        });
        this.emit(
          this.mk("tool.updated", {
            toolCallId: event.toolCallId,
            outputPreview: safePreview(partialText),
          }),
        );
        break;
      }
      case "tool_execution_end": {
        this.activeTools.delete(event.toolCallId);
        const result = event.result as { details?: { patch?: unknown; diff?: unknown } } | undefined;
        const patchRaw = result?.details?.patch ?? result?.details?.diff;
        // 与 buildSnapshot 的 toolResult 分支保持一致：取 text 块纯文本。
        // 直接 safePreview(result) 会把 {"content":[{"type":"text",...}]}
        // 原样渲染，而切换会话后的快照路径却是纯文本，两边对不上。
        const resultText = extractText(result);
        // 注意：工具级 isError 不置 lastError——模型会看到错误结果并自行
        // 恢复（如 edit 的 old_string 不匹配后重试），属正常工作流；若在
        // 这里置位，agent_settled 会把整轮误判成 failed（「Agent 异常停止」）。
        this.emit(
          this.mk("tool.finished", {
            toolCallId: event.toolCallId,
            isError: event.isError,
            ...(resultText ? { resultPreview: safePreview(resultText) } : {}),
            ...(patchRaw ? { patch: safePreview(patchRaw) } : {}),
          }),
        );
        break;
      }
      case "agent_start": {
        this.state = "running";
        this.lastError = undefined;
        this.armWatchdog();
        this.emit(this.mk("agent.state", { state: "running" }));
        break;
      }
      case "agent_end":
      case "agent_settled": {
        this.disarmWatchdog();
        this.state = this.lastError ? "failed" : "idle";
        if (this.lastError) {
          this.emit(this.mk("agent.failed", { kind: "llm", message: this.lastError }));
        }
        this.emit(this.mk("agent.state", { state: this.state }));
        // 首轮对话结束后自动起标题（pi 不落盘无名会话，此时文件已写入）。
        void this.autoTitleSession();
        break;
      }
      case "auto_retry_start": {
        // LLM 错误自动重试中：记录错误，重试耗尽后 run 结束时判 failed。
        this.lastError = event.errorMessage;
        break;
      }
      case "auto_retry_end": {
        // 重试成功则清除错误，run 正常收尾；失败则保留，settled 时判 failed。
        if (event.success) this.lastError = undefined;
        break;
      }
      case "compaction_start": {
        this.emit(this.mk("context.compaction", { phase: "started" }));
        break;
      }
      case "compaction_end": {
        this.emit(this.mk("context.compaction", { phase: "finished" }));
        break;
      }
      default:
        // queue_update / steer / followUp etc.: recorded in snapshot only. §6.1
        break;
    }
  }

  // ── snapshot ───────────────────────────────────────────────────────────────

  buildSnapshot(pendingApprovals: AgentSnapshot["pendingApprovals"]): AgentSnapshot {
    const messages: AgentSnapshot["messages"] = [];
    const tools: AgentSnapshot["tools"] = [];
    let ordinal = 0;
    // 走 sessionManager entries 而非 session.messages：entry.timestamp 是
    // message_end 落盘时间，配合 message.timestamp（流开始）可恢复耗时；
    // toolResult 消息也在 entries 里，可重建已完成工具卡。
    const entries = this.session?.sessionManager.getEntries() ?? [];
    // assistant 消息里发出的 toolCall（id → name/arguments/发出时间），等 toolResult 来配对。
    const openCalls = new Map<string, { name: string; arguments: unknown; startTs?: number }>();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const m = entry.message as {
        role?: string;
        content?: unknown;
        timestamp?: number;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
      };
      const endMs = Date.parse(entry.timestamp);
      if (m.role === "assistant") {
        ordinal++;
        for (const c of (m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }> | undefined) ?? []) {
          if (c.type === "toolCall" && c.id) {
            // 发出时间用 assistant 消息落盘时间（≈ tool calls 发出时刻）。
            openCalls.set(c.id, { name: c.name ?? "", arguments: c.arguments, startTs: endMs });
          }
        }
        const startMs = m.timestamp;
        const text = extractText(m);
        const thinking = extractThinking(m);
        messages.push({
          messageId: `${this.sessionId}:m:${ordinal}`,
          role: "assistant",
          text,
          thinking,
          // 思考耗时只能从 JSONL 近似恢复：thinking 块没有独立时间戳。
          // thinking-only 消息（后接工具调用）整段时长 ≈ 思考时长，保留；
          // thinking + text 混合消息整段时长包含正文生成时间，会显示成
          // 失真的「思考了 11s」，宁可不给（UI 回退成「推理过程」）。
          ...(thinking && !text && Number.isFinite(startMs) && Number.isFinite(endMs)
            ? { durationSec: Math.max(0, (endMs - startMs!) / 1000) }
            : {}),
          // 排序时间用 entry.timestamp（落盘时间）：pi 会把 assistant 消息的
          // message.timestamp 写成与其消费的 toolResult 相同的毫秒值，稳定
          // 排序会让该消息被拉到工具卡前面（切换会话后多出一个「思考了」块）。
          ...(Number.isFinite(endMs)
            ? { timestamp: endMs }
            : Number.isFinite(startMs)
              ? { timestamp: startMs }
              : {}),
        });
      } else if (m.role === "user") {
        messages.push({
          messageId: `u:${ordinal}`,
          role: "user",
          text: extractText(m),
          ...(Number.isFinite(m.timestamp) ? { timestamp: m.timestamp } : {}),
        });
      } else if (m.role === "toolResult") {
        const call = openCalls.get(m.toolCallId ?? "");
        if (call) openCalls.delete(m.toolCallId!);
        const contentText = extractText(m);
        const resultTs = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : undefined;
        tools.push({
          toolCallId: m.toolCallId ?? `tool:${tools.length}`,
          toolName: m.toolName ?? call?.name ?? "unknown",
          inputPreview: safePreview(call?.arguments ?? {}),
          ...(contentText ? { resultPreview: safePreview(contentText) } : {}),
          isError: Boolean(m.isError),
          timestamp: resultTs ?? (Number.isFinite(endMs) ? endMs : 0),
          ...(resultTs !== undefined && call?.startTs !== undefined
            ? { durationSec: Math.max(0, (resultTs - call.startTs) / 1000) }
            : {}),
        });
      }
    }
    // 未配对的 toolCall（中断/崩溃残留）：只补输入侧，避免静默丢失。
    for (const [id, call] of openCalls) {
      tools.push({
        toolCallId: id,
        toolName: call.name,
        inputPreview: safePreview(call.arguments ?? {}),
        isError: false,
        timestamp: Number.MAX_SAFE_INTEGER,
      });
    }

    return {
      version: 1,
      lastSequence: this.sequence,
      cwd: this.host.getCwd(),
      trust: this.host.getTrust(),
      session: {
        id: this.sessionId,
        file: this.session?.sessionFile,
        name: this.session?.sessionName,
      },
      agentState: this.state,
      messages,
      tools,
      activeToolPreviews: [...this.activeTools].map(([toolCallId, t]) => ({
        toolCallId,
        toolName: t.name,
        preview: t.preview,
      })),
      pendingApprovals,
      authState: {
        configured: false,
        provider: null,
        maskedHint: null,
      },
      models: [],
      selectedModel:
        this.session?.model != null
          ? `${this.session.model.provider}/${this.session.model.id}`
          : null,
      forkCandidates: this.session
        ? this.session.getUserMessagesForForking().map((u) => ({
            entryId: u.entryId,
            text: u.text.length > 200 ? `${u.text.slice(0, 200)}…` : u.text,
          }))
        : [],
      authProviders: this.listAuthProviders(),
    };
  }

  async fullAuthModels(): Promise<Pick<AgentSnapshot, "authState" | "models">> {
    return {
      authState: await this.authState(),
      models: this.modelRuntime ? await this.listModels() : [],
    };
  }

  /**
   * Verify the path is an existing .jsonl inside OUR sessions dir (symlinks
   * resolved), returning its canonical path. §5.3
   */
  private ensureOwnSessionFile(pathInput: string): string {
    const abs = isAbsolute(pathInput) ? pathInput : resolve(this.host.paths.sessionsDir, pathInput);
    let st;
    try {
      st = statSync(abs); // follows symlinks — escape via symlink resolves here
    } catch {
      throw new Error("not_found: session file does not exist");
    }
    const real = realpathSync(abs);
    const dirReal = realpathSync(this.host.paths.sessionsDir);
    if (!st.isFile() || !(real === dirReal || real.startsWith(dirReal + "/"))) {
      throw new Error("session path outside app session dir");
    }
    return real;
  }

  sessionFilePath(): string | undefined {
    return this.session?.sessionFile;
  }
}

function extractText(m: unknown): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => String((b as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

function extractThinking(m: unknown): string | undefined {
  const content = (m as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .filter((b) => (b as { type?: string }).type === "thinking")
    .map((b) => String((b as { thinking?: string }).thinking ?? (b as { text?: string }).text ?? ""))
    .join("");
  return thinking || undefined;
}

function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export function sessionDisplayName(file: string | undefined): string {
  return file ? basename(file) : "(unsaved)";
}
