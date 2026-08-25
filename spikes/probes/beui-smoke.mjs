#!/usr/bin/env node
// beUI integration smoke: boot the built app over CDP, capture renderer
// errors, confirm beUI semantic tokens reached the CSS, quit.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_DIR = new URL("../../apps/desktop/", import.meta.url).pathname;
const PORT = 9223;

const proc = spawn(
  "pnpm",
  ["exec", "electron", ".", "--remote-debugging-port=" + String(PORT)],
  {
    cwd: APP_DIR,
    env: { ...process.env, SPIKE_DATA_DIR: mkdtempSync(join(tmpdir(), "beui-smoke-")) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
proc.stdout.on("data", () => {});
proc.stderr.on("data", () => {});

async function waitForTargets(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = (await r.json());
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return targets;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("CDP target never appeared");
}

function evaluate(ws, id, expr) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result?.result?.value ?? "");
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

const errors = [];
try {
  await waitForTargets();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  // Collect console errors while we interact.
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
    }
  });
  ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));

  await new Promise((r) => setTimeout(r, 2500)); // let React mount

  const result = JSON.parse(
    await evaluate(ws, 2, `JSON.stringify({
      rootChildren: document.getElementById('root').children.length,
      gateText: document.body.innerText.slice(0, 80),
      // beUI/shadcn tokens resolved into computed styles
      bgVar: getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim(),
      cardVar: getComputedStyle(document.documentElement).getPropertyValue('--color-card').trim(),
      cardClass: typeof CSS !== 'undefined' && [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.cssText.includes('--color-success')); } catch { return false; } }),
      motionImported: (() => { try { return typeof window.requestAnimationFrame === 'function'; } catch { return false; } })(),
    })`),
  );

  console.log("MOUNT:", JSON.stringify(result, null, 2));
  console.log("RENDERER_ERRORS:", errors.length ? errors : "(none)");
  const ok =
    result.rootChildren > 0 &&
    result.bgVar.length > 0 &&
    result.cardClass === true &&
    !errors.some((e) => /Uncaught|Cannot|not defined|failed to/i.test(e));
  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
} catch (e) {
  console.error("SMOKE ERROR:", e);
} finally {
  proc.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
}
