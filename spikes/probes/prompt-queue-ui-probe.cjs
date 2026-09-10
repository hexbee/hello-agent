// Real Electron renderer/preload with a fake Main API. No credentials or LLM calls.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const directory = mkdtempSync(join(tmpdir(), "hello-queue-ui-"));
app.setPath("userData", directory);
const sessionId = "queue-ui";
const cwd = join(directory, "project");
const file = join(directory, "sessions", `${sessionId}.jsonl`);
let state = "running";
let sequence = 0;
let queue = { revision: 0, paused: false, items: [] };
let win;
const calls = [];
const send = (event) => win.webContents.send("agent.event", { version: 1, sequence: ++sequence, sessionId, timestamp: Date.now(), ...event });
const snapshot = () => ({
  version: 1, lastSequence: sequence, cwd, trust: "trusted", permissionMode: "default",
  session: { id: sessionId, file, name: "队列测试" }, agentState: state,
  messages: [{ messageId: "u1", role: "user", text: "先检查当前项目", timestamp: 1 },
    { messageId: "a1", role: "assistant", text: "正在检查项目。你可以继续交代下一轮任务。", timestamp: 2 }],
  tools: [], activeToolPreviews: [], pendingApprovals: [], promptQueue: queue,
  authState: { configured: true, provider: "test", maskedHint: null }, authProviders: [],
  models: [{ provider: "test", id: "test-model", context: 8192 }], selectedModel: "test/test-model",
  contextUsage: null, thinkingLevel: "off", thinkingLevels: ["off"], skills: [], skillDiagnostics: [], forkCandidates: [],
});
const ok = (data) => ({ ok: true, data });
const mutate = (operation) => {
  operation();
  queue.revision++;
  send({ type: "queue.updated", queue });
  return ok(queue);
};
for (const [channel, handler] of Object.entries({
  "agent.snapshot": () => ok(snapshot()),
  "session.list": () => ok([{ file, name: "队列测试", modified: 1 }]),
  "projects.sessions": () => ok([{ cwd, name: "测试项目", sessions: [{ file, name: "队列测试", modified: 1 }] }]),
  "projects.list": () => ok({ projects: [cwd], lastOpened: cwd }),
  "agent.prompt": () => { throw new Error("Running UI must not use direct prompt"); },
  "agent.queue.add": (input) => mutate(() => {
    if (!queue.items.some((i) => i.id === input.id)) queue.items.push({ id: input.id, text: input.text, status: "queued", createdAt: Date.now() });
  }),
  "agent.queue.edit": (input) => mutate(() => { queue.items.find((i) => i.id === input.id).text = input.text; }),
  "agent.queue.remove": (input) => mutate(() => { queue.items = queue.items.filter((i) => i.id !== input.id); }),
  "agent.queue.control": (input) => mutate(() => { queue.paused = input.paused; }),
  "agent.abort": () => {
    state = "aborted";
    mutate(() => { queue.paused = true; });
    send({ type: "agent.state", state });
    return ok({ aborted: true });
  },
})) ipcMain.handle(channel, (_event, input) => { calls.push(channel); return handler(input); });

const delay = (ms) => new Promise((res) => setTimeout(res, ms));
async function wait(check, name) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${name}`);
}
const run = (code) => win.webContents.executeJavaScript(code);
const exists = (selector) => run(`!!document.querySelector(${JSON.stringify(selector)})`);
async function fill(label, text) {
  await run(`(() => {
    const el = document.querySelector('textarea[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(50);
}
async function rowButton(index, text) {
  await run(`Array.from(document.querySelectorAll('section[aria-label="待发送消息"] li')[${index}].querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: resolve(__dirname, "../../apps/desktop/out/preload/index.cjs"),
    } });
    await win.loadFile(resolve(__dirname, "../../apps/desktop/out/renderer/index.html"));
    await wait(() => exists('button[aria-label="加入队列"]'), "running composer");
    assert.ok(await exists('button[aria-label="停止当前任务并暂停队列"]'));
    await fill("Prompt", "第一条待办");
    await run(`(() => { const f = document.querySelector('textarea[aria-label="Prompt"]').form; f.requestSubmit(); f.requestSubmit(); })()`);
    await wait(() => queue.items.length === 1, "first enqueue");
    assert.equal(calls.filter((c) => c === "agent.queue.add").length, 1);
    await fill("Prompt", "第二条待办");
    await run(`document.querySelector('textarea[aria-label="Prompt"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await wait(() => queue.items.length === 2, "Enter enqueues second");
    await rowButton(1, "编辑");
    await wait(() => exists('textarea[aria-label="编辑待发送消息"]'), "queue editor");
    assert.equal(queue.paused, true);
    await fill("编辑待发送消息", "修改后的第二条待办");
    await rowButton(1, "保存");
    await wait(() => queue.items[1]?.text === "修改后的第二条待办", "save edited text");
    await wait(async () => !await exists('textarea[aria-label="编辑待发送消息"]'), "editor closed");
    await rowButton(0, "取消");
    await wait(() => queue.items.length === 1, "cancel first");
    await fill("Prompt", "刷新后仍保留的草稿");
    await run(`document.querySelector('button[aria-label="停止当前任务并暂停队列"]').click()`);
    await wait(() => state === "aborted", "stop current run");
    assert.equal(queue.paused, true);
    await run(`Array.from(document.querySelectorAll('section[aria-label="待发送消息"] > div button')).find(b => b.textContent.trim() === '继续队列').click()`);
    await wait(() => queue.paused === false, "resume queue");
    await run(`Array.from(document.querySelectorAll('section[aria-label="待发送消息"] > div button')).find(b => b.textContent.trim() === '暂停后续').click()`);
    await wait(() => queue.paused === true, "pause queue");
    const loaded = new Promise((res) => win.webContents.once("did-finish-load", res));
    win.webContents.reload();
    await loaded;
    await wait(() => exists('section[aria-label="待发送消息"]'), "queue after renderer reload");
    assert.equal(await run(`document.querySelector('textarea[aria-label="Prompt"]').value`), "刷新后仍保留的草稿");
    assert.ok(await run(`document.querySelector('section[aria-label="待发送消息"]').textContent.includes('修改后的第二条待办')`));
    assert.equal(calls.filter((c) => c === "agent.prompt").length, 0);
    assert.equal(calls.filter((c) => c === "agent.queue.add").length, 2, "reload cannot resubmit queued messages");
    const image = await win.webContents.capturePage();
    const screenshot = process.env.QUEUE_UI_SCREENSHOT || join(tmpdir(), "hello-agent-queue-ui.png");
    writeFileSync(screenshot, image.toPNG());
    console.log("✓ Electron UI: separate stop/enqueue, Enter, rapid submit, edit/save/cancel, pause/resume and reload");
    console.log(`Screenshot: ${screenshot}`);
    win.destroy();
    rmSync(directory, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (win && !win.isDestroyed()) win.destroy();
    rmSync(directory, { recursive: true, force: true });
    app.exit(1);
  }
});
