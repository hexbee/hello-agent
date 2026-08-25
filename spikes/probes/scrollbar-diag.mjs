#!/usr/bin/env node
// Scrollbar diagnosis: boot dev app, force ready phase with fake entries via
// the live store module, then report which elements actually scroll and what
// their computed scrollbar-width is.
import { spawn } from "node:child_process";

const APP_DIR = new URL("../../apps/desktop/", import.meta.url).pathname;
const PORT = 9224;

const proc = spawn("pnpm", ["exec", "electron-vite", "dev", "--", "--remote-debugging-port=" + String(PORT)], {
  cwd: APP_DIR,
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", () => {});
proc.stderr.on("data", () => {});

async function waitTarget(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = await r.json();
      const page = t.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no CDP target");
}

function evaluate(ws, id, expr) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result?.result?.value);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

try {
  const page = await waitTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  await new Promise((r) => setTimeout(r, 3000)); // dev server + react mount

  const setup = `
    (async () => {
      const m = await import('/src/renderer/store.ts');
      const store = m.store;
      const msgs = [];
      for (let i = 0; i < 20; i++) {
        msgs.push({ kind: 'message', messageId: 'u'+i, role: 'user', text: '用户消息 '+i+'，测试滚动。'.repeat(5), thinking: null, streaming: false });
        msgs.push({ kind: 'message', messageId: 'a'+i, role: 'assistant', text: ('助手回复 '+i+'。').repeat(40), thinking: null, streaming: false });
      }
      store['set']({ phase: 'ready', cwd: '/tmp/fake', trust: 'trusted', entries: msgs, agentState: 'idle' });
      await new Promise(r => setTimeout(r, 800));
      return 'ready';
    })()
  `;
  const state = await evaluate(ws, 1, setup);

  const diag = JSON.parse(
    await evaluate(ws, 2, `JSON.stringify({
      phase: document.body.innerText.slice(0, 40),
      scroller: (() => {
        const el = document.querySelector('[data-slot="message-scroller"]');
        if (!el) return null;
        const section = el.querySelector('section');
        return {
          rootClass: el.className,
          sectionClass: section?.className?.slice(0, 200),
          sectionScrollW: section ? getComputedStyle(section).scrollbarWidth : null,
          overflow: section ? section.scrollHeight > section.clientHeight : null,
        };
      })(),
      scrollers: (() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) {
            out.push({
              tag: el.tagName,
              slot: el.getAttribute('data-slot'),
              cls: (el.className.baseVal ?? el.className ?? '').toString().slice(0, 90),
              sbw: getComputedStyle(el).scrollbarWidth,
              oy: getComputedStyle(el).overflowY,
            });
          }
        }
        return out;
      })(),
    })`),
  );

  console.log("STATE:", state);
  console.log(JSON.stringify(diag, null, 2));
} catch (e) {
  console.error("PROBE ERROR:", e);
} finally {
  proc.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
}
