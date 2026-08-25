// Renderer state store — applies the §6.1 product event stream on top of
// snapshot replay, with sequence-gap detection → agent.snapshot recovery.

import type { AgentEvent, AgentSnapshot, SafePreview } from "@hello-agent/shared";
import { useSyncExternalStore } from "react";
import { api, unwrap } from "./api";

export type TrustLevel = "untrusted" | "restricted" | "trusted";

export type ToolItem = {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  inputPreview?: SafePreview;
  outputPreview?: SafePreview;
  resultPreview?: SafePreview;
  patch?: SafePreview;
  isError?: boolean;
  status: "running" | "done";
  /** 本地流式的开始时间（快照回放的工具卡没有）。 */
  startedAt?: number;
  /** 执行耗时秒数，tool.finished 时结算；用于工具卡 meta 显示。 */
  durationSec?: number;
};

export type MessageItem = {
  kind: "message";
  messageId: string;
  role: "user" | "assistant";
  text: string;
  thinking: string | null;
  streaming: boolean;
  /** 本地流式的起始时间（快照回放的消息没有）。 */
  startedAt?: number;
  /** 流式总耗时秒数，message.finished 时结算；用于「思考了 Ns」摘要。 */
  durationSec?: number;
};

export type ChatEntry = MessageItem | ToolItem;

export type PendingApproval = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  displayInput: SafePreview;
  createdAt: number;
};

export type SessionInfo = { file: string; name?: string; modified?: number };

export type StoreState = {
  phase: "gate" | "ready";
  cwd: string;
  trust: TrustLevel;
  agentState: "idle" | "running" | "aborted" | "failed";
  entries: ChatEntry[];
  pendingApprovals: PendingApproval[];
  sessions: SessionInfo[];
  session: { id: string; file?: string; name?: string } | null;
  models: Array<{ provider: string; id: string; context: number | null }>;
  selectedModel: string | null;
  authState: AgentSnapshot["authState"];
  authProviders: AgentSnapshot["authProviders"];
  forkCandidates: Array<{ entryId: string; text: string }>;
  banner: { kind: "error" | "info"; text: string } | null;
  authDialogOpen: boolean;
};

const initialState: StoreState = {
  phase: "gate",
  cwd: "",
  trust: "untrusted",
  agentState: "idle",
  entries: [],
  pendingApprovals: [],
  sessions: [],
  session: null,
  models: [],
  selectedModel: null,
  authState: { configured: false, provider: null, maskedHint: null },
  authProviders: [],
  forkCandidates: [],
  banner: null,
  authDialogOpen: false,
};

class Store {
  private state: StoreState = initialState;
  private listeners = new Set<() => void>();
  private lastSequence = 0;
  private seqStarted = false;

  getState = (): StoreState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Mutate one chat entry by predicate (immutable copy of the array only). */
  private updateEntry<T extends ChatEntry>(
    pred: (e: ChatEntry) => e is T,
    fn: (e: T) => T,
  ): void {
    let changed = false;
    const entries = this.state.entries.map((e) => {
      if (!pred(e)) return e;
      const next = fn(e);
      if (next !== e) changed = true;
      return next as ChatEntry;
    });
    if (changed) this.set({ entries });
  }

  // ── bootstrap / workspace ─────────────────────────────────────────────────

  async init(): Promise<void> {
    api().events.subscribe((raw) => this.applyEvent(raw as AgentEvent));
    // Restore an in-progress workspace after reload (§6.3 snapshot recovery).
    await this.tryRestoreWorkspace();
  }

  async openWorkspace(): Promise<void> {
    try {
      const r = unwrap(await api().workspace.pickAndOpen());
      this.set({ cwd: r.cwd, trust: r.trust as TrustLevel });
    } catch {
      /* user cancelled or error — stay on gate */
    }
  }

  async setTrust(trust: "restricted" | "trusted"): Promise<void> {
    try {
      const r = unwrap(await api().workspace.setTrust(trust));
      this.set({ cwd: r.cwd, trust: r.trust as TrustLevel });
      await this.enterWorkspace();
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  async closeWorkspace(): Promise<void> {
    try {
      await api().workspace.close();
    } finally {
      this.lastSequence = 0;
      this.seqStarted = false;
      this.state = { ...initialState };
      for (const l of this.listeners) l();
    }
  }

  /** After trust is granted: create/verify runtime, load everything. */
  async enterWorkspace(): Promise<void> {
    try {
      await this.refreshSnapshot();
      this.set({ phase: "ready" });
      await this.refreshSessions();
    } catch (e) {
      this.set({ phase: "gate", banner: { kind: "error", text: String(e) } });
    }
  }

  /** Reload-time restore: if a runtime already exists in Main, resume it. */
  private async tryRestoreWorkspace(): Promise<void> {
    try {
      const snap = unwrap(await api().agent.snapshot());
      this.applySnapshot(snap);
      if (snap.cwd && snap.trust !== "untrusted") {
        this.set({ phase: "ready", cwd: snap.cwd, trust: snap.trust });
        await this.refreshSessions();
      }
    } catch {
      /* no runtime — gate */
    }
  }

  async refreshSessions(): Promise<void> {
    try {
      const sessions = unwrap(await api().session.list());
      console.log("[sessions] 刷新:", sessions.length, "个", sessions.map((s) => s.name ?? s.file.split("/").pop()));
      this.set({ sessions });
    } catch (e) {
      console.warn("[sessions] 刷新失败:", e);
    }
  }

  // ── snapshot ───────────────────────────────────────────────────────────────

  applySnapshot(snap: AgentSnapshot): void {
    this.lastSequence = snap.lastSequence;
    this.seqStarted = true;
    // 同会话 resync（序列间隙恢复）用合并而非整体重建：
    // 快照不含已完成工具卡、进行中的流式消息和本地计时字段，
    // 整体替换会导致工具卡消失、流式消息被删（后续 delta 全部落空、
    // message.finished 无法结算 → 摘要回退成「推理过程」）。
    // 会话切换/首次加载仍走干净重建。
    const sameSession =
      this.state.session?.id != null && this.state.session.id === snap.session.id;

    // 快照的统一条目视图：消息（含耗时）+ 已完成工具卡 + 运行中预览，按时间序交错。
    type SnapEntry =
      | {
          kind: "message";
          messageId: string;
          role: "user" | "assistant";
          text: string;
          thinking?: string;
          durationSec?: number;
          timestamp?: number;
        }
      | {
          kind: "tool";
          toolCallId: string;
          toolName: string;
          inputPreview: SafePreview;
          resultPreview?: SafePreview;
          isError: boolean;
          running: boolean;
          timestamp: number;
          durationSec?: number;
        };
    const snapList: SnapEntry[] = [
      ...snap.messages.map((m) => ({
        kind: "message" as const,
        messageId: m.messageId,
        role: m.role,
        text: m.text,
        thinking: m.thinking,
        durationSec: m.durationSec,
        timestamp: m.timestamp,
      })),
      ...snap.tools.map((t) => ({
        kind: "tool" as const,
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        inputPreview: t.inputPreview,
        resultPreview: t.resultPreview,
        isError: t.isError,
        running: false,
        timestamp: t.timestamp,
        durationSec: t.durationSec,
      })),
      ...snap.activeToolPreviews.map((t, i) => ({
        kind: "tool" as const,
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        inputPreview: t.preview,
        isError: false,
        running: true,
        timestamp: Number.MAX_SAFE_INTEGER + i,
      })),
    ].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    const toEntry = (s: SnapEntry): ChatEntry =>
      s.kind === "message"
        ? {
            kind: "message",
            messageId: s.messageId,
            role: s.role,
            text: s.text,
            thinking: s.thinking ?? null,
            streaming: false,
            durationSec: s.durationSec,
          }
        : {
            kind: "tool",
            toolCallId: s.toolCallId,
            toolName: s.toolName,
            inputPreview: s.inputPreview,
            resultPreview: s.resultPreview,
            isError: s.isError,
            status: s.running ? "running" : "done",
            durationSec: s.durationSec,
          };

    let entries: ChatEntry[];
    if (!sameSession) {
      entries = snapList.map(toEntry);
    } else {
      const entries_ = [...this.state.entries];
      const findLocal = (id: string) =>
        entries_.findIndex(
          (e) => (e.kind === "message" ? e.messageId : e.toolCallId) === id,
        );
      // 落盘的用户消息与本地合成条目（local:u:*，pi 无用户消息事件只能
      // 先本地画）按文本配对：配对成功就地换成真实 messageId，保住位置
      // 且不产生重复气泡。
      const syntheticUsers = entries_
        .map((e, idx) =>
          e.kind === "message" && e.role === "user" && e.messageId.startsWith("local:u:")
            ? { idx, e }
            : null,
        )
        .filter((x): x is { idx: number; e: MessageItem } => x !== null);
      const paired = new Set<number>();

      // 游标合并：快照条目按时间序走一遍；已存在的就地更新（保留本地
      // 元数据），新增的插入到游标处，保持与快照一致的相对顺序；
      // 本地独有条目（流式中消息、运行中工具）原样保留。
      let cursor = 0;
      for (const s of snapList) {
        const id = s.kind === "message" ? s.messageId : s.toolCallId;
        const at = findLocal(id);
        if (at !== -1) {
          const e = entries_[at]!;
          if (s.kind === "message" && e.kind === "message") {
            entries_[at] = {
              ...e,
              text: s.text,
              thinking: s.thinking ?? null,
              streaming: false,
              durationSec:
                e.durationSec ??
                s.durationSec ??
                (e.startedAt !== undefined
                  ? Math.max(0, (Date.now() - e.startedAt) / 1000)
                  : undefined),
            };
          } else if (s.kind === "tool" && e.kind === "tool") {
            entries_[at] = {
              ...e,
              resultPreview: e.resultPreview ?? s.resultPreview,
              isError: s.running ? e.isError : s.isError,
              status: s.running ? e.status : "done",
            };
          }
          if (at >= cursor) cursor = at + 1;
          continue;
        }
        if (s.kind === "message" && s.role === "user") {
          const match = syntheticUsers.find(
            (x) => !paired.has(x.idx) && x.e.text === s.text,
          );
          if (match) {
            paired.add(match.idx);
            entries_[match.idx] = {
              ...match.e,
              messageId: s.messageId,
              text: s.text,
            };
            if (match.idx >= cursor) cursor = match.idx + 1;
            continue;
          }
        }
        entries_.splice(cursor, 0, toEntry(s));
        for (const su of syntheticUsers) {
          if (su.idx >= cursor) su.idx += 1;
        }
        cursor += 1;
      }
      // 本地仍在 running 但快照已不含的工具：finished 事件在间隙中丢失，
      // 就地终结，避免永久转圈。
      const activeIds = new Set(snap.activeToolPreviews.map((t) => t.toolCallId));
      entries = entries_.map((e) =>
        e.kind === "tool" && e.status === "running" && !activeIds.has(e.toolCallId)
          ? { ...e, status: "done" as const }
          : e,
      );
    }
    this.set({
      entries,
      pendingApprovals: snap.pendingApprovals,
      session: snap.session.id ? snap.session : null,
      models: snap.models,
      selectedModel: snap.selectedModel,
      authState: snap.authState,
      authProviders: snap.authProviders ?? this.state.authProviders,
      forkCandidates: snap.forkCandidates ?? [],
      trust: snap.trust,
      cwd: snap.cwd || this.state.cwd,
    });
  }

  async refreshSnapshot(): Promise<void> {
    const snap = unwrap(await api().agent.snapshot());
    this.applySnapshot(snap);
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private applyEvent(e: AgentEvent): void {
    // Sequence-gap detection (§6.1): any gap → full snapshot resync.
    if (typeof e.sequence === "number") {
      if (this.seqStarted && e.sequence > this.lastSequence + 1) {
        this.lastSequence = e.sequence;
        // 流式期间 delta 走批处理器、非 delta 直接透传，乱序在这里是常态。
        // 丢弃乱序事件后用快照恢复，但快照不含会话列表，需一并刷新，
        // 否则新会话要等到下次切换会话才会出现在侧边栏。
        console.log("[events] 序列间隙，丢弃并恢复:", e.type, e.sequence);
        void this.refreshSnapshot().catch(() => undefined);
        void this.refreshSessions().catch(() => undefined);
        return;
      }
      this.lastSequence = e.sequence;
      this.seqStarted = true;
    }

    switch (e.type) {
      case "message.started": {
        this.set({
          entries: [
            ...this.state.entries,
            {
              kind: "message",
              messageId: e.messageId,
              role: e.role,
              text: "",
              thinking: null,
              streaming: true,
              startedAt: Date.now(),
            },
          ],
        });
        break;
      }
      case "message.delta":
      case "thinking.delta": {
        this.updateEntry(
          (x): x is MessageItem => x.kind === "message" && x.messageId === e.messageId,
          (m) =>
            e.type === "message.delta"
              ? {
                  ...m,
                  text: m.text + e.delta,
                  // 首段正文到达即结算思考耗时：思考时长 ≈ 消息开始 → 首个正文
                  // delta。等 message.finished 才结算会把正文生成时间也算进去
                  //（短思考长回答时会显示成「思考了 11s」）。
                  durationSec:
                    m.durationSec ??
                    (m.thinking && m.startedAt !== undefined
                      ? Math.max(0, (Date.now() - m.startedAt) / 1000)
                      : undefined),
                }
              : { ...m, thinking: (m.thinking ?? "") + e.delta },
        );
        break;
      }
      case "message.finished": {
        this.updateEntry(
          (x): x is MessageItem => x.kind === "message" && x.messageId === e.messageId,
          (m) => ({
            ...m,
            streaming: false,
            ...(m.startedAt && m.durationSec === undefined
              ? { durationSec: Math.max(0, (Date.now() - m.startedAt) / 1000) }
              : {}),
          }),
        );
        break;
      }
      case "tool.started": {
        this.set({
          entries: [
            ...this.state.entries,
            {
              kind: "tool",
              toolCallId: e.toolCallId,
              toolName: e.toolName,
              inputPreview: e.inputPreview,
              status: "running",
              startedAt: Date.now(),
            },
          ],
        });
        break;
      }
      case "tool.updated": {
        this.updateEntry(
          (x): x is ToolItem => x.kind === "tool" && x.toolCallId === e.toolCallId,
          (t) => ({ ...t, outputPreview: e.outputPreview }),
        );
        break;
      }
      case "tool.finished": {
        this.updateEntry(
          (x): x is ToolItem => x.kind === "tool" && x.toolCallId === e.toolCallId,
          (t) => ({
            ...t,
            status: "done",
            isError: e.isError,
            resultPreview: e.resultPreview,
            ...(e.patch ? { patch: e.patch } : {}),
            durationSec:
              t.durationSec ??
              (t.startedAt !== undefined
                ? Math.max(0, (Date.now() - t.startedAt) / 1000)
                : undefined),
          }),
        );
        break;
      }
      case "agent.state": {
        this.set({ agentState: e.state });
        // 一轮结束（含中断/失败）时终结残留的流式消息，避免永久 streaming。
        if (e.state !== "running" && this.state.entries.some((x) => x.kind === "message" && x.streaming)) {
          const entries = this.state.entries.map((x) =>
            x.kind === "message" && x.streaming
              ? {
                  ...x,
                  streaming: false,
                  durationSec:
                    x.durationSec ??
                    (x.startedAt !== undefined
                      ? Math.max(0, (Date.now() - x.startedAt) / 1000)
                      : undefined),
                }
              : x,
          );
          this.set({ entries });
        }
        // pi 的会话文件是懒落盘的：首条 assistant 消息到达时才写入 .jsonl。
        // 一轮对话结束（idle/failed）后文件已存在，此时刷新侧边栏，
        // 否则新会话要等到下次切换会话才会出现在列表里。
        if (e.state === "idle" || e.state === "failed") {
          void this.refreshSessions().catch(() => undefined);
        }
        break;
      }
      case "agent.failed": {
        this.set({ banner: { kind: "error", text: `${e.kind}: ${e.message}` } });
        break;
      }
      case "session.renamed": {
        // 自动起标题 / 手动改名后同步侧边栏（新标题已持久化到 session_info）。
        if (this.state.session) {
          this.set({ session: { ...this.state.session, name: e.name } });
        }
        void this.refreshSessions().catch(() => undefined);
        break;
      }
      case "approval.requested": {
        this.set({
          pendingApprovals: [
            ...this.state.pendingApprovals.filter((p) => p.requestId !== e.requestId),
            {
              requestId: e.requestId,
              toolCallId: e.toolCallId,
              toolName: e.toolName,
              displayInput: e.displayInput,
              createdAt: e.timestamp,
            },
          ],
        });
        break;
      }
      case "approval.resolved": {
        this.set({
          pendingApprovals: this.state.pendingApprovals.filter(
            (p) => p.requestId !== e.requestId,
          ),
        });
        break;
      }
      case "context.compaction":
        break; // v0.1: no dedicated UI; visible via snapshot only
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async prompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const messageId = `local:u:${Date.now()}`;
    // 乐观追加：main 侧 prompt IPC 只等 preflight 就返回，但事件与 IPC
    // 返回的到达顺序不保证——先画气泡再发请求，失败时回滚。
    this.set({
      entries: [
        ...this.state.entries,
        {
          kind: "message",
          messageId,
          role: "user",
          text: trimmed,
          thinking: null,
          streaming: false,
        },
      ],
      banner: null,
    });
    try {
      const r = unwrap(await api().agent.prompt(trimmed));
      if (!r.accepted) {
        // preflight 拒绝（如 agent 忙）：撤回本地气泡。
        this.set({
          entries: this.state.entries.filter(
            (x) => !(x.kind === "message" && x.messageId === messageId),
          ),
          banner: { kind: "error", text: "Agent 正在运行，消息未发送" },
        });
      }
    } catch (e) {
      this.set({
        entries: this.state.entries.filter(
          (x) => !(x.kind === "message" && x.messageId === messageId),
        ),
        banner: { kind: "error", text: String(e) },
      });
    }
  }

  async abort(): Promise<void> {
    try {
      await api().agent.abort();
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  /** §4.5 — user-triggered runtime rebuild after a failure. */
  async rebuild(): Promise<void> {
    this.set({ agentState: "idle" });
    try {
      unwrap(await api().agent.rebuild());
      this.seqStarted = false;
      this.lastSequence = 0;
      await this.refreshSnapshot();
      await this.refreshSessions();
      this.set({ banner: { kind: "info", text: "Runtime 已重建" } });
    } catch (e) {
      this.set({ banner: { kind: "error", text: `重建失败：${String(e)}` }, agentState: "failed" });
    }
  }

  async resolveApproval(
    requestId: string,
    decision: "allow" | "allow-once" | "deny",
  ): Promise<void> {
    const sessionId = this.state.session?.id ?? "";
    try {
      unwrap(await api().approvals.resolve(requestId, sessionId, decision));
    } catch (e) {
      this.set({ banner: { kind: "error", text: `审批提交失败：${String(e)}` } });
    }
  }

  async newSession(): Promise<void> {
    try {
      const r = unwrap(await api().session.create());
      await this.afterSessionSwitch(r.sessionId);
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  async openSession(path: string): Promise<void> {
    try {
      const r = unwrap(await api().session.open(path));
      await this.afterSessionSwitch(r.sessionId);
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  async renameSession(name: string): Promise<void> {
    try {
      unwrap(await api().session.rename(name));
      this.set({
        session: this.state.session ? { ...this.state.session, name } : null,
      });
      await this.refreshSessions();
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  async deleteSession(path: string): Promise<void> {
    try {
      unwrap(await api().session.delete(path));
      await this.refreshSessions();
      if (this.state.session?.file === path) await this.newSession();
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  async fork(entryId: string): Promise<void> {
    try {
      const r = unwrap(await api().session.fork(entryId));
      await this.afterSessionSwitch(r.sessionId);
      this.set({ banner: { kind: "info", text: "已从所选消息分叉新会话" } });
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  /** Session replacement clears local chat state; snapshot rebuilds history. */
  private async afterSessionSwitch(sessionId: string): Promise<void> {
    this.seqStarted = false;
    this.lastSequence = 0;
    await this.refreshSnapshot();
    await this.refreshSessions();
    void sessionId;
  }

  async selectModel(ref: string): Promise<void> {
    try {
      const r = unwrap(await api().models.select(ref));
      this.set({ selectedModel: r.selected, banner: null });
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }

  dismissBanner(): void {
    this.set({ banner: null });
  }

  openAuthDialog(): void {
    void this.refreshSnapshot().catch(() => undefined);
    this.set({ authDialogOpen: true, banner: null });
  }

  closeAuthDialog(): void {
    this.set({ authDialogOpen: false });
  }

  /** §8 — submit API key; Main verifies then persists via secure storage. */
  async submitApiKey(provider: string, apiKey: string): Promise<void> {
    try {
      const st = unwrap(await api().auth.submitKey(provider, apiKey));
      await this.refreshSnapshot();
      this.set({ authDialogOpen: false, authState: st, banner: { kind: "info", text: `${provider} 凭据已保存到系统安全存储` } });
    } catch (e) {
      // Keep dialog open; show error inside it via banner.
      this.set({ banner: { kind: "error", text: String(e) } });
    }
  }
}

export const store = new Store();

export function useStore(): StoreState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
