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
};

export type MessageItem = {
  kind: "message";
  messageId: string;
  role: "user" | "assistant";
  text: string;
  thinking: string | null;
  streaming: boolean;
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
    const entries: ChatEntry[] = [];
    for (const m of snap.messages) {
      entries.push({
        kind: "message",
        messageId: m.messageId,
        role: m.role,
        text: m.text,
        thinking: m.thinking ?? null,
        streaming: false,
      });
    }
    for (const t of snap.activeToolPreviews) {
      entries.push({
        kind: "tool",
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        inputPreview: t.preview,
        status: "running",
      });
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
              ? { ...m, text: m.text + e.delta }
              : { ...m, thinking: (m.thinking ?? "") + e.delta },
        );
        break;
      }
      case "message.finished": {
        this.updateEntry(
          (x): x is MessageItem => x.kind === "message" && x.messageId === e.messageId,
          (m) => ({ ...m, streaming: false }),
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
          }),
        );
        break;
      }
      case "agent.state": {
        this.set({ agentState: e.state });
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
    try {
      unwrap(await api().agent.prompt(trimmed));
      // pi has no user-message event; append locally (snapshot replays it later).
      this.set({
        entries: [
          ...this.state.entries,
          {
            kind: "message",
            messageId: `local:u:${Date.now()}`,
            role: "user",
            text: trimmed,
            thinking: null,
            streaming: false,
          },
        ],
        banner: null,
      });
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
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

  async resolveApproval(requestId: string, decision: "allow" | "deny"): Promise<void> {
    const sessionId = this.state.session?.id ?? "";
    try {
      unwrap(await api().approvals.resolve(requestId, sessionId, decision));
    } catch (e) {
      this.set({ banner: { kind: "error", text: String(e) } });
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
