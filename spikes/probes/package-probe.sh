#!/usr/bin/env bash
# §10.9 — packaged-product verification.
# Builds the unsigned dir-target package and runs two probes against the real
# .app bundle: renderer sandbox checks + full agent-stack smoke (credentials,
# runtime, session persistence) inside the asar/unpack context.
#
# SKIP_PKG_BUILD=1 to reuse an existing release/ build.
set -euo pipefail
cd "$(dirname "$0")/../../apps/desktop"

if [ "${SKIP_PKG_BUILD:-0}" != "1" ]; then
  ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
    pnpm exec electron-builder --dir > /tmp/pkg-build.log 2>&1 || {
    echo "✗ electron-builder failed — see /tmp/pkg-build.log"; exit 1;
  }
fi

APP=$(ls -d release/*/mac-arm64/hello-agent.app 2>/dev/null | head -1)
[ -n "$APP" ] || { echo "✗ packaged app not found"; exit 1; }
BIN="$APP/Contents/MacOS/hello-agent"
T=$(mktemp -d)
fail=0

# ── probe 1: renderer sandbox (main-world checks) ──
SPIKE_SANDBOX_PROBE=1 SPIKE_PROBE_OUT="$T/sb.json" SPIKE_DATA_DIR="$T/data" "$BIN" > /dev/null 2>&1 || true
sleep 1

node --input-type=module - "$T/sb.json" << 'EOF' || fail=1
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const checks = [
  ["no Node require", r.hasNodeRequire === false],
  ["no process", r.hasProcess === false],
  ["no ipcRenderer", r.hasIpcRenderer === false],
  ["preload bridge exposed", r.hasSpikeBridge === true],
  ["no generic invoke/send", r.noGenericInvoke === true],
];
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) process.exitCode = 1;
}
EOF

# ── probe 2: agent stack deep smoke inside the package ──
SPIKE_PKG_PROBE=1 SPIKE_PROBE_OUT="$T/deep.json" SPIKE_DATA_DIR="$T/data2" "$BIN" > /dev/null 2>&1 || true
sleep 1

node --input-type=module - "$T/deep.json" << 'EOF' || fail=1
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const checks = [
  ["credential store roundtrip", r.credentialStored === true],
  ["credential encrypted at rest", r.credentialEncrypted === true],
  ["runtime created (unpacked pi)", r.runtimeCreated === true],
  ["permission extension bound", r.extensionBound === true],
  ["session persisted to app dir", r.sessionPersisted === true],
  ["model catalog available", (r.modelsCatalog ?? 0) > 0],
];
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) process.exitCode = 1;
}
EOF

rm -rf "$T"
exit $fail
