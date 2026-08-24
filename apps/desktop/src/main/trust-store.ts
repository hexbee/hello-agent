// Trust record persistence — §4.2: "信任记录保存于应用设置（key = canonical
// workspace path）"。App-private JSON file, never under ~/.pi/**. Records are
// keyed by canonical path; invalidation rules:
//   - path unresolvable / workspace removed → checked at openWorkspace time
//     (realpath fails ⇒ state machine goes to Failed before any restore)
//   - manual revocation → revoke() (v0.1 exposes no UI yet)
// Untrusted is NOT persisted: it is the absence of a grant (§4.2), so closing
// the app or reopening a folder without a record always lands on untrusted.

import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type GrantLevel = "restricted" | "trusted";

interface TrustRecord {
  trust: GrantLevel;
  grantedAt: number;
}

interface TrustFile {
  version: 1;
  grants: Record<string, TrustRecord>;
}

const EMPTY: TrustFile = { version: 1, grants: {} };

export class TrustStore {
  private grants: Record<string, TrustRecord> = {};

  constructor(private readonly filePath: string) {}

  /** Load from disk; a corrupt/unreadable file resets to empty (fail-closed). */
  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as TrustFile;
      this.grants =
        parsed && parsed.version === 1 && typeof parsed.grants === "object" && parsed.grants !== null
          ? parsed.grants
          : {};
    } catch {
      this.grants = {};
    }
    // Defensive sanitize: drop malformed entries instead of trusting file content.
    for (const [k, v] of Object.entries(this.grants)) {
      if (
        typeof k !== "string" ||
        !k.startsWith("/") ||
        (v as TrustRecord | undefined)?.trust !== "restricted" && v?.trust !== "trusted" ||
        typeof v?.grantedAt !== "number"
      ) {
        delete this.grants[k];
      }
    }
  }

  get(canonicalCwd: string): GrantLevel | undefined {
    return this.grants[canonicalCwd]?.trust;
  }

  /** Persist a grant atomically (tmp + rename). Throws on fs failure. */
  grant(canonicalCwd: string, trust: GrantLevel): void {
    this.grants[canonicalCwd] = { trust, grantedAt: Date.now() };
    this.flush();
  }

  /** Remove the record entirely (manual revocation semantics, §4.2). */
  revoke(canonicalCwd: string): void {
    if (!(canonicalCwd in this.grants)) return;
    delete this.grants[canonicalCwd];
    this.flush();
  }

  private flush(): void {
    mkdirSync(join(this.filePath, ".."), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, grants: this.grants }, null, 2));
    renameSync(tmp, this.filePath);
  }
}
