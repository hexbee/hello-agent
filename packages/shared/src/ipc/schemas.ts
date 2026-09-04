// Runtime validators for every Renderer → Main command — §6.3.
// Hand-written, dependency-free. TypeScript types are NOT runtime validation.

import type { Result } from "./commands.js";

type Validator<T> = (input: unknown) => Result<T>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ok = <T>(data: T) => ({ ok: true as const, data });
const err = (message: string) => ({
  ok: false as const,
  error: { code: "invalid_input" as const, message },
});

function str(v: unknown): v is string {
  return typeof v === "string";
}
function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function objectValidator<T>(spec: Record<string, (v: unknown) => boolean>): Validator<T> {
  return (input) => {
    if (!isRecord(input)) return err("expected object");
    for (const [key, check] of Object.entries(spec)) {
      if (!(key in input)) return err(`missing field: ${key}`);
      if (!check(input[key])) return err(`invalid field: ${key}`);
    }
    // Reject unexpected extra keys to keep the surface tight.
    for (const key of Object.keys(input)) {
      if (!(key in spec)) return err(`unexpected field: ${key}`);
    }
    return ok(input as T);
  };
}

// ── workspace ────────────────────────────────────────────────────────────────

export interface WorkspaceOpenInput {
  token: string;
}
export const validateWorkspaceOpen = objectValidator<WorkspaceOpenInput>({ token: str });

export type WorkspaceTrustSetInput = { trust: "restricted" | "trusted" };
export const validateWorkspaceTrustSet = objectValidator<WorkspaceTrustSetInput>({
  trust: (v) => v === "restricted" || v === "trusted",
});

// ── auth / models ────────────────────────────────────────────────────────────

export interface AuthBeginInput {
  provider: string;
}
export const validateAuthBegin = objectValidator<AuthBeginInput>({
  provider: (v) => str(v) && /^[a-z0-9-]{1,64}$/.test(v),
});

export interface AuthSubmitKeyInput {
  provider: string;
  apiKey: string;
}
export const validateAuthSubmitKey = objectValidator<AuthSubmitKeyInput>({
  provider: (v) => str(v) && /^[a-z0-9-]{1,64}$/.test(v),
  apiKey: (v) => str(v) && v.length >= 8 && v.length <= 4096,
});

export interface AuthRemoveKeyInput {
  provider: string;
}
export const validateAuthRemoveKey = objectValidator<AuthRemoveKeyInput>({
  provider: (v) => str(v) && /^[a-z0-9-]{1,64}$/.test(v),
});

export interface ModelsSelectInput {
  ref: string;
}
export const validateModelsSelect = objectValidator<ModelsSelectInput>({
  ref: (v) => str(v) && v.length <= 256,
});

// ── sessions ─────────────────────────────────────────────────────────────────

export interface SessionOpenInput {
  path: string;
}
export const validateSessionOpen = objectValidator<SessionOpenInput>({
  path: (v) => str(v) && v.length > 0 && v.length <= 1024,
});

export interface SessionForkInput {
  entryId: string | null;
}
export const validateSessionFork = objectValidator<SessionForkInput>({
  entryId: (v) => v === null || (str(v) && v.length > 0 && v.length <= 256),
});

export interface SessionRenameInput {
  name: string;
}
export const validateSessionRename = objectValidator<SessionRenameInput>({
  name: (v) => str(v) && v.trim().length > 0 && v.length <= 200,
});

export interface SessionDeleteInput {
  path: string;
}
export const validateSessionDelete = objectValidator<SessionDeleteInput>({
  path: (v) => str(v) && v.length > 0 && v.length <= 1024,
});

// ── agent ────────────────────────────────────────────────────────────────────

export interface AgentPromptInput {
  text: string;
}
export const validateAgentPrompt = objectValidator<AgentPromptInput>({
  text: (v) => str(v) && v.length > 0 && v.length <= 100_000,
});

// ── permissions ──────────────────────────────────────────────────────────────

export interface PermissionModeSetInput {
  mode: "default" | "full";
}
export const validatePermissionModeSet = objectValidator<PermissionModeSetInput>({
  mode: (v) => v === "default" || v === "full",
});

export interface ApprovalResolveInput {
  requestId: string;
  decision: "allow" | "allow-once" | "deny";
  sessionId: string;
}
export const validateApprovalResolve = objectValidator<ApprovalResolveInput>({
  requestId: (v) => str(v) && v.length > 0 && v.length <= 128,
  decision: (v) => v === "allow" || v === "allow-once" || v === "deny",
  sessionId: (v) => str(v) && v.length > 0 && v.length <= 128,
});

// ── dev-only ────────────────────────────────────────────────────────────────

export interface DevStressDeltasInput {
  count: number;
  sizeBytes: number;
}
export const validateDevStressDeltas = objectValidator<DevStressDeltasInput>({
  count: (v) => num(v) && Number.isInteger(v) && v > 0 && v <= 100_000,
  sizeBytes: (v) => num(v) && Number.isInteger(v) && v > 0 && v <= 65_536,
});
