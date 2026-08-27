import type { AgentSnapshot } from "./events.js";

// Renderer → Main command contract — docs/desktop-agent-tech-stack.md §6.2
// Every command defines: request, success result, error result. Runtime
// validators live in schemas.ts.

export type TrustLevel = "untrusted" | "restricted" | "trusted";

export type CommandError = {
  code:
    | "invalid_input"
    | "untrusted_workspace"
    | "no_runtime"
    | "not_found"
    | "busy"
    | "auth_required"
    | "denied"
    | "internal";
  message: string;
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: CommandError };

// ── workspace ────────────────────────────────────────────────────────────────

export interface WorkspaceOpenRequest {
  /** Absolute path chosen via dialog in Main; Renderer only sends the dialog token. */
  token: string;
}
export type WorkspaceOpenResult = {
  cwd: string;
  trust: TrustLevel;
};

export interface WorkspaceTrustSetRequest {
  trust: Exclude<TrustLevel, "untrusted">;
}
export type WorkspaceTrustSetResult = { cwd: string; trust: TrustLevel };

export type WorkspaceCloseResult = { closed: true };

// ── auth / models ────────────────────────────────────────────────────────────

export type AuthStatusResult = AgentSnapshot["authState"];

export interface AuthBeginRequest {
  provider: string;
}
export type AuthBeginResult = { oauthUrl?: string };

export interface AuthSubmitKeyRequest {
  provider: string;
  apiKey: string;
}
export type AuthSubmitKeyResult = AuthStatusResult;

export type AuthCancelResult = { cancelled: true };

export type ModelsListResult = AgentSnapshot["models"];

export interface ModelsSelectRequest {
  ref: string; // "provider/id"
}
export type ModelsSelectResult = { selected: string | null };

// ── sessions ─────────────────────────────────────────────────────────────────

export type SessionListResult = Array<{
  file: string;
  name: string | undefined;
  modified: number | undefined;
}>;

export interface SessionOpenRequest {
  path: string;
}
export type SessionOpenResult = { sessionId: string };

export type SessionNewResult = { sessionId: string };

export interface SessionForkRequest {
  entryId: string;
}
export type SessionForkResult = { sessionId: string };

export interface SessionRenameRequest {
  name: string;
}
export type SessionRenameResult = { renamed: true };

export interface SessionDeleteRequest {
  path: string;
}
export type SessionDeleteResult = { deleted: true };

// ── agent ────────────────────────────────────────────────────────────────────

export interface AgentPromptRequest {
  text: string;
}
export type AgentPromptResult = { accepted: boolean };

export type AgentAbortResult = { aborted: true };

export type AgentSnapshotResult = AgentSnapshot;

/** §4.5 explicit runtime rebuild (dispose → same-cwd recreate → restore latest session). */
export interface AgentRebuildResult {
  rebuilt: true;
  restoredSessionId: string | null;
}

// ── permissions ──────────────────────────────────────────────────────────────

/**
 * 会话级权限模式（Composer 上的「权限」选择）：
 * - default 默认权限：只读工具自动放行，写文件 / bash 等仍需审批（现状行为）
 * - full 完全访问：所有工具自动放行，不再弹审批卡（审计记录仍保留）
 * 会话切换时回到 default（与 session allow 规则同生命周期）。
 */
export type PermissionMode = "default" | "full";

export interface PermissionModeSetRequest {
  mode: PermissionMode;
}
export type PermissionModeSetResult = { mode: PermissionMode };

/** 审批 TTL，Main 的 PermissionManager 与 Renderer 倒计时共用。 */
export const APPROVAL_TTL_MS = 60_000;

export interface ApprovalResolveRequest {
  requestId: string;
  /** allow = 本会话内记住（低风险工具后续自动放行）；allow-once = 仅本次；deny = 拒绝。 */
  decision: "allow" | "allow-once" | "deny";
  /** Echoed session the request belongs to; Main verifies ownership (§6.3). */
  sessionId: string;
}
export type ApprovalResolveResult = { resolved: true };

// ── dev-only (spike instrumentation) ─────────────────────────────────────────

export interface DevStressDeltasRequest {
  count: number;
  sizeBytes: number;
}
export type DevStressDeltasResult = { started: true };
