#!/usr/bin/env bash
# §10.6 — Renderer sandbox verification against the BUILT app.
# The app quits itself after writing results, so this runs electron in the
# foreground (backgrounding breaks under non-interactive shells).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp /tmp/spike-sandbox-XXXX.json)
trap 'rm -f "$OUT"' EXIT

pnpm --filter @hello-agent/desktop build > /dev/null

SPIKE_SANDBOX_PROBE=1 SPIKE_PROBE_OUT="$OUT" \
  ./apps/desktop/node_modules/.bin/electron ./apps/desktop > /dev/null 2>&1 || true

[ -s "$OUT" ] || { echo "✗ probe produced no output"; exit 1; }

node --input-type=module - "$OUT" << 'EOF'
import { readFileSync } from "node:fs";
const raw = readFileSync(process.argv[2], "utf8");
const r = JSON.parse(raw);
const checks = [
  ["renderer has no Node require", r.hasNodeRequire === false],
  ["renderer has no process", r.hasProcess === false],
  ["renderer has no ipcRenderer", r.hasIpcRenderer === false],
  ["preload bridge exposed", r.hasSpikeBridge === true],
  ["no generic invoke/send on bridge", r.noGenericInvoke === true],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) fail++;
}
if ("error" in r) {
  console.log(`✗ probe error: ${r.error}${r.diag?.length ? " | " + r.diag.join(" | ") : ""}`);
  fail++;
}
process.exit(fail ? 1 : 0);
EOF
