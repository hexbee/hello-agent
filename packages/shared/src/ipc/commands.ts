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

export interface ApprovalResolveRequest {
  requestId: string;
  decision: "allow" | "deny";
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
