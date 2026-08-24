// Host environment abstraction — lets the agent stack run identically inside
// Electron Main and in headless probes (spikes/probes/*) without importing
// electron anywhere under src/main/agent/.

import type { AgentEvent, SafePreview } from "@hello-agent/shared";
import type { CredentialStore as PiCredentialStore } from "@earendil-works/pi-ai";

export type TrustLevel = "untrusted" | "restricted" | "trusted";

export interface AgentHostPaths {
  /** App-private agentDir (redirects pi away from ~/.pi/agent). §4.3 */
  agentDir: string;
  /** App-owned session dir (explicit sessionManager param). §4.4 */
  sessionsDir: string;
  /** App-owned models.json path. §4.4 */
  modelsPath: string;
  modelsStorePath: string;
  auditFile: string;
}

export interface AgentHost {
  paths: AgentHostPaths;
  /** Canonical workspace cwd for the active runtime. Empty string = no workspace. */
  getCwd(): string;
  getTrust(): TrustLevel;
  /** Deliver one product event to the UI surface (IPC in Electron; collector in probes). */
  emit(event: AgentEvent): void;
  /** Masked auth hint source, e.g. env-injected key. Never returns raw keys. */
  getEnvKey(providerId: string): string | undefined;
  /** App-owned credential store backing ModelRuntime (§8). Probes omit it and use env keys. */
  credentials?: PiCredentialStore;
  /** Non-secret credential metadata for UI status (never key material). */
  credentialMeta?(providerId: string): { type: string; maskedHint: string | null } | undefined;
  /** Recoverable delete (§1.3): move to OS trash. Electron impl uses shell.trashItem. */
  moveToTrash(path: string): Promise<boolean>;
  moveToTrash(path: string): Promise<boolean>;
}

import { realpathSync } from "node:fs";

const MAX_PREVIEW_CHARS = 2_000;

/**
 * Allowlist serialization + truncation + redaction → SafePreview. §6.1 tool
 * data rules. The allowlist applies to the TOP level of an object; nested
 * structures under allowed keys pass through (truncated) so tool results stay
 * readable.
 */
export function safePreview(value: unknown, opts?: { maxChars?: number }): SafePreview {
  const maxChars = opts?.maxChars ?? MAX_PREVIEW_CHARS;
  let source: unknown = value;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = truncateDeep(v, 0);
    }
    source = filtered;
  } else {
    source = truncateDeep(source, 0);
  }
  let text: string;
  try {
    text = typeof source === "string" ? source : (JSON.stringify(source) ?? "");
  } catch {
    text = "[unserializable]";
  }
  const redacted = CREDENTIAL_PATTERN.test(text);
  text = text.replace(CREDENTIAL_PATTERN, "$1[REDACTED]$2");
  return {
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    redacted,
  };
}

const ALLOWED_KEYS = new Set([
  "command",
  "path",
  "file_path",
  "file",
  "pattern",
  "glob",
  "query",
  "old_string",
  "new_string",
  "content",
  "cwd",
  "note",
  "reason",
  "label",
]);

function truncateDeep(v: unknown, depth: number): unknown {
  if (typeof v === "string") return v.slice(0, MAX_PREVIEW_CHARS);
  if (Array.isArray(v)) {
    return v.slice(0, 20).map((x) => truncateDeep(x, depth + 1));
  }
  if (v && typeof v === "object") {
    // Unknown nested objects pass through structurally (still credential-
    // redacted by the pattern applied to the final string).
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (++n > 40) break;
      out[k] = truncateDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

const CREDENTIAL_PATTERN =
  /(\"(?:api[-_]?key|key|token|secret|password|authorization|credential)\"\\s*:\s*\")[^"]*(\")/gi;


export function canonicalize(input: string): string | undefined {
  try {
    return realpathSync(input);
  } catch {
    return undefined;
  }
}