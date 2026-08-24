// §8 — app-owned credential storage backed by Electron safeStorage
// (Keychain on macOS, DPAPI on Windows, libsecret on Linux). Raw keys never
// leave Main; only masked hints are exposed. Implements the pi-ai
// CredentialStore interface so ModelRuntime reads credentials per request.

import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Credential,
  CredentialInfo,
  CredentialStore as PiCredentialStore,
} from "@earendil-works/pi-ai";

type StoredEntry = { enc: string; type: "api_key" | "oauth"; hint: string | null };
type StoredFile = { version: 1; entries: Record<string, StoredEntry> };

export class SafeStorageCredentialStore implements PiCredentialStore {
  private file: string;
  private cache: StoredFile | undefined;
  /** Per-provider serialization for modify/delete (interface contract). */
  private locks = new Map<string, Promise<unknown>>();

  constructor(file: string) {
    this.file = file;
  }

  private load(): StoredFile {
    if (this.cache) return this.cache;
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoredFile;
        if (parsed.version === 1 && parsed.entries) return (this.cache = parsed);
      }
    } catch {
      // Corrupt file → start clean; credentials are re-enterable, audit notes it.
      console.warn("[credentials] unreadable store, starting clean");
    }
    return (this.cache = { version: 1, entries: {} });
  }

  private save(state: StoredFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(state, null, 0), { mode: 0o600 });
    this.cache = state;
  }

  private requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("secure storage unavailable on this platform");
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const entry = this.load().entries[providerId];
    if (!entry) return undefined;
    this.requireEncryption();
    const plain = safeStorage.decryptString(Buffer.from(entry.enc, "base64"));
    return JSON.parse(plain) as Credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load().entries).map(([providerId, e]) => ({
      providerId,
      type: e.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const prev = this.locks.get(providerId) ?? Promise.resolve();
    const run = prev.then(() => this.modifyLocked(providerId, fn));
    this.locks.set(
      providerId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async modifyLocked(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next === current || next === undefined) return next;
    this.requireEncryption();
    const state = this.load();
    state.entries[providerId] = {
      enc: safeStorage.encryptString(JSON.stringify(next)).toString("base64"),
      type: next.type,
      hint: maskCredential(next),
    };
    this.save(state);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    const prev = this.locks.get(providerId) ?? Promise.resolve();
    await prev.then(() => {
      const state = this.load();
      if (state.entries[providerId]) {
        delete state.entries[providerId];
        this.save(state);
      }
    });
  }

  /** Non-secret status for UI. Never returns key material. */
  describe(providerId: string): { type: string; maskedHint: string | null } | undefined {
    const entry = this.load().entries[providerId];
    if (!entry) return undefined;
    return { type: entry.type, maskedHint: entry.hint };
  }
}

function maskCredential(c: Credential): string | null {
  if (c.type !== "api_key" || !c.key) return null;
  const k = c.key;
  return k.length > 10 ? `${k.slice(0, 3)}…${k.slice(-4)}` : "•••";
}
