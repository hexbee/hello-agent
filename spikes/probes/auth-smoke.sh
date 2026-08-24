#!/usr/bin/env bash
# §8 auth smoke probe — must run AFTER `pnpm build` (needs out/main/auth-smoke.js).
set -euo pipefail
cd "$(dirname "$0")/../../apps/desktop"

OUT="${TMPDIR:-/tmp}/auth-smoke-out.json"
rm -f "$OUT"

AUTH_SMOKE_OUT="$OUT" ./node_modules/.bin/electron ./out/main/auth-smoke.js > /dev/null 2>&1 || true

[ -s "$OUT" ] || { echo "✗ auth-smoke produced no output"; exit 1; }

node --input-type=module - "$OUT" << 'EOF'
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (r.fatal) {
  console.log(`✗ auth-smoke fatal: ${r.fatal}`);
  process.exit(1);
}
const checks = [
  ["credential stored", r.stored === true],
  ["masked hint exposes no key material", r.hintMasked === true],
  ["raw key not in store file", r.rawKeyNotInFile === true],
  ["credential encrypted at rest", r.encryptedAtRest === true],
  ["ModelRuntime resolves api_key auth", r.authCheckType === "api_key"],
  ["provider models available via store", (r.deepseekModels ?? 0) > 0],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
EOF
