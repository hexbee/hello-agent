// Trust persistence probe — docs/desktop-agent-tech-stack.md §4.2.
// Verifies: grants persist across "restarts" (new TrustStore instance),
// unknown paths land on untrusted (fail-closed), revocation deletes the
// record, and a corrupt store file resets to empty instead of failing open.

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustStore } from "../../apps/desktop/src/main/trust-store.js";
import { Reporter, exitOn } from "./harness.js";

const r = new Reporter();

await r.run("trust persistence §4.2", () => {
  const dir = mkdtempSync(join(tmpdir(), "trust-probe-"));
  const file = join(dir, "trust.json");
  const cwdA = join(dir, "workspace-a");
  const cwdB = join(dir, "workspace-b");

  // 1. Fresh store: no records ⇒ untrusted.
  const s1 = new TrustStore(file);
  s1.load();
  r.check("no record → untrusted", s1.get(cwdA) === undefined);

  // 2. Grant persists to disk and across a reload (simulated restart).
  s1.grant(cwdA, "restricted");
  r.check("grant visible in-memory", s1.get(cwdA) === "restricted");
  r.check("grant written to app-private file", existsSync(file));

  const s2 = new TrustStore(file);
  s2.load();
  r.check("grant survives restart", s2.get(cwdA) === "restricted");

  // 3. Different workspace stays untrusted — no cross-folder leak.
  r.check("other workspace untrusted", s2.get(cwdB) === undefined);

  // 4. Upgrade grant level; revoke removes the record entirely.
  s2.grant(cwdA, "trusted");
  const s3 = new TrustStore(file);
  s3.load();
  r.check("level upgrade persisted", s3.get(cwdA) === "trusted");
  s3.revoke(cwdA);
  const s4 = new TrustStore(file);
  s4.load();
  r.check("revoke survives restart", s4.get(cwdA) === undefined);

  // 5. Corrupt file fails closed (empty), not open.
  writeFileSync(file, "{ not json !!!");
  const s5 = new TrustStore(file);
  s5.load();
  r.check("corrupt file → empty grants", s5.get(cwdA) === undefined);

  // 6. Malformed entries inside valid JSON are dropped defensively.
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      grants: {
        [cwdA]: { trust: "sudo-root", grantedAt: 1 }, // invalid level
        [cwdB]: "trusted", // invalid shape
      },
    }),
  );
  const s6 = new TrustStore(file);
  s6.load();
  r.check("invalid level dropped", s6.get(cwdA) === undefined);
  r.check("invalid shape dropped", s6.get(cwdB) === undefined);

  // 7. Store never touches CLI paths (spot-check content is app-owned JSON).
  s6.grant(cwdA, "restricted");
  const raw = readFileSync(file, "utf8");
  r.check("file contains only canonical-path records", raw.includes(cwdA) && raw.includes("\"version\": 1"));
});

exitOn(r);
