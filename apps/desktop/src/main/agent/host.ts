// Host environment abstraction — lets the agent stack run identically inside
// Electron Main and in headless probes (spikes/probes/*) without importing
// electron anywhere under src/main/agent/.

import type { AgentEvent, SafePreview } from "@spike/shared";

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
}

import { realpathSync } from "node:fs";

const MAX_PREVIEW_CHARS = 2_000;

/** Allowlist serialization + truncation + redaction → SafePreview. §6.1 tool data rules. */
export function safePreview(value: unknown, opts?: { maxChars?: number }): SafePreview {
  const maxChars = opts?.maxChars ?? MAX_PREVIEW_CHARS;
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else if (value === undefined || value === null) text = "";
    else text = JSON.stringify(value, safeReplacer(), 0) ?? "";
  } catch {
    text = "[unserializable]";
  }
  const redacted = text !== text.replace(CREDENTIAL_PATTERN, "$1[REDACTED]");
  text = text.replace(CREDENTIAL_PATTERN, "$1[REDACTED]");
  return {
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    redacted,
  };
}

const CREDENTIAL_PATTERN =
  /("(?:api[-_]?key|key|token|secret|password|authorization|credential)"\s*:\s*")[^"]*(")/gi;

function safeReplacer() {
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
  return (_key: string, value: unknown) => {
    if (typeof value === "string") return value.slice(0, MAX_PREVIEW_CHARS);
    if (Array.isArray(value)) return value.slice(0, 20);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (ALLOWED_KEYS.has(k)) out[k] = v;
      }
      return out;
    }
    return value;
  };
}

export function canonicalize(input: string): string | undefined {
  try {
    return realpathSync(input);
  } catch {
    return undefined;
  }
}