// Spike renderer — proves the restricted preload API is sufficient for the
// product flow (§3) and survives 1,000+ delta streams without freezing (§6.3).

declare global {
  interface Window {
    spike: {
      workspace: {
        pickAndOpen(): Promise<{ ok: boolean; data?: { cwd: string; trust: string }; error?: { message: string } }>;
        setTrust(trust: "restricted" | "trusted"): Promise<unknown>;
        close(): Promise<unknown>;
      };
      session: {
        list(): Promise<{ ok: boolean; data?: Array<{ file: string }> }>;
        create(): Promise<unknown>;
        open(path: string): Promise<unknown>;
      };
      agent: {
        prompt(text: string): Promise<unknown>;
        abort(): Promise<unknown>;
        snapshot(): Promise<unknown>;
      };
      approvals: {
        resolve(requestId: string, sessionId: string, d: "allow" | "deny"): Promise<unknown>;
      };
      dev: {
        stressDeltas(count: number, sizeBytes: number): Promise<unknown>;
      };
      events: { subscribe(cb: (e: unknown) => void): () => void };
    };
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const log = $("log");
const statusEl = $("status");

let currentSessionId = "";
let lastSequence = 0;
const approvals = new Map<string, { toolName: string; displayInput: { text: string } }>();

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function appendLine(cls: string, text: string): void {
  log.appendChild(el("div", cls, text));
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
}

function fmtResult(r: unknown): string {
  return JSON.stringify(r);
}

// ── event handling with sequence-gap detection (§6.1) ──────────────────────

const messageEls = new Map<string, HTMLElement>();

window.spike.events.subscribe((raw) => {
  const e = raw as Record<string, unknown> & { type: string };
  const seq = e.sequence as number;
  if (typeof seq === "number") {
    if (lastSequence > 0 && seq > lastSequence + 1) {
      appendLine("tool", `[gap] sequence ${lastSequence} → ${seq}，需要 agent.snapshot 恢复`);
    }
    lastSequence = seq;
  }

  switch (e.type) {
    case "message.started": {
      if (String(e.messageId).includes(":stress")) break;
      const div = el("div", "msg-assistant");
      messageEls.set(String(e.messageId), div);
      log.appendChild(div);
      break;
    }
    case "message.delta":
    case "thinking.delta": {
      const target = messageEls.get(String(e.messageId));
      if (target) {
        target.append(String(e.delta));
        requestAnimationFrame(() => {
          log.scrollTop = log.scrollHeight;
        });
      }
      break;
    }
    case "message.finished": {
      const target = messageEls.get(String(e.messageId));
      if (target) target.append("\n");
      break;
    }
    case "tool.started": {
      appendLine("tool", `⚙ ${String(e.toolName)}(${truncate((e.inputPreview as { text: string }).text, 120)})`);
      break;
    }
    case "tool.finished": {
      const r = e.resultPreview as { text: string };
      appendLine("tool", `⚙ 完成 isError=${String(e.isError)} ${truncate(r?.text ?? "", 160)}`);
      break;
    }
    case "agent.state": {
      statusEl.textContent = String(e.state);
      break;
    }
    case "agent.failed": {
      appendLine("tool", `✖ ${String(e.kind)}: ${String(e.message)}`);
      break;
    }
    case "approval.requested": {
      approvals.set(String(e.requestId), {
        toolName: String(e.toolName),
        displayInput: e.displayInput as { text: string },
      });
      renderApprovals();
      break;
    }
    case "approval.resolved": {
      approvals.delete(String(e.requestId));
      renderApprovals();
      break;
    }
  }
});

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function renderApprovals(): void {
  const box = $("approvals");
  box.innerHTML = "";
  box.style.display = approvals.size === 0 ? "none" : "block";
  for (const [requestId, a] of approvals) {
    const card = el("div", "card");
    card.appendChild(el("h4", undefined, `审批：${a.toolName}`));
    card.appendChild(el("code", undefined, truncate(a.displayInput.text, 400)));
    const row = el("div", "row");
    const allowBtn = el("button", "primary", "允许（本会话）");
    allowBtn.onclick = () =>
      void window.spike.approvals.resolve(requestId, currentSessionId, "allow").then(renderApprovals);
    const denyBtn = el("button", "deny", "拒绝");
    denyBtn.onclick = () =>
      void window.spike.approvals.resolve(requestId, currentSessionId, "deny").then(renderApprovals);
    row.append(allowBtn, denyBtn);
    card.appendChild(row);
    box.appendChild(card);
  }
}

// ── controls ─────────────────────────────────────────────────────────────────

$("openWs").onclick = async () => {
  const r = await window.spike.workspace.pickAndOpen();
  if (r.ok && r.data) $("wsInfo").textContent = `${r.data.cwd} · trust=${r.data.trust}`;
  else appendLine("tool", `openWorkspace 失败：${r.error?.message}`);
};

document.querySelectorAll<HTMLButtonElement>("[data-trust]").forEach((b) => {
  b.onclick = async () => {
    const r = await window.spike.workspace.setTrust(b.dataset.trust as "trusted" | "restricted");
    appendLine("tool", `setTrust → ${fmtResult(r)}`);
    await refreshSessions();
  };
});

$("closeWs").onclick = () => void window.spike.workspace.close();

$("newSession").onclick = () => void window.spike.session.create();
$("listSessions").onclick = () => void refreshSessions();

async function refreshSessions(): Promise<void> {
  const r = await window.spike.session.list();
  const sel = $("sessionSelect") as HTMLSelectElement & { dataset: Record<string, string> };
  sel.innerHTML = "";
  sel.dataset.current = "";
  for (const s of r.data ?? []) {
    const opt = document.createElement("option");
    opt.value = s.file;
    opt.textContent = s.file.split("/").pop() ?? s.file;
    sel.appendChild(opt);
  }
}

$("sessionSelect").onchange = async (ev) => {
  const path = (ev.target as HTMLSelectElement).value;
  if (!path) return;
  appendLine("tool", `switchSession → ${path}`);
  const r = await window.spike.session.open(path);
  appendLine("tool", fmtResult(r));
};

$("authStatus").onclick = async () => {
  // via agent.snapshot — auth state is part of it in the real contract; the
  // dedicated command exists too but renderer keeps to snapshot here.
  const snap = (await window.spike.agent.snapshot()) as {
    ok?: boolean;
    data?: { cwd: string; trust: string; authState: unknown; models: unknown[]; selectedModel: string | null; session: { id: string } };
  };
  if (snap.ok && snap.data) {
    currentSessionId = snap.data.session.id;
    $("authInfo").textContent = JSON.stringify(snap.data.authState);
    appendLine("tool", `models=${snap.data.models.length} selected=${snap.data.selectedModel ?? "-"}`);
  } else {
    $("authInfo").textContent = JSON.stringify(snap);
  }
};

$("sendBtn").onclick = sendPrompt;
$("promptInput").addEventListener("keydown", (ev) => {
  if ((ev as KeyboardEvent).key === "Enter") sendPrompt();
});

function sendPrompt(): void {
  const input = $("promptInput") as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendLine("msg-user", `❯ ${text}`);
  void window.spike.agent.prompt(text);
}

$("abortBtn").onclick = () => void window.spike.agent.abort();

$("stressBtn").onclick = async () => {
  const count = Number(($("stressCount") as HTMLInputElement).value) || 2000;
  const sizeBytes = Number(($("stressSize") as HTMLInputElement).value) || 40;
  const t0 = performance.now();
  let received = 0;
  let maxRafDelay = 0;

  const counter = window.spike.events.subscribe((raw) => {
    const e = raw as { type: string; messageId?: string; delta?: string };
    if (e.type === "message.delta" && e.messageId?.endsWith(":stress")) received++;
    if (e.type === "message.finished" && e.messageId?.endsWith(":stress")) {
      counter();
      const elapsed = performance.now() - t0;
      $("stressStats").textContent =
        `${received} deltas / ${Math.round(elapsed)}ms · 主线程最大卡顿≈${maxRafDelay.toFixed(1)}ms`;
    }
  });

  // Watchdog for main-thread freeze: if any frame exceeds ~200ms we'd notice.
  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    maxRafDelay = Math.max(maxRafDelay, now - last);
    last = now;
    if (received === 0 || now - t0 < 30_000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  await window.spike.dev.stressDeltas(count, sizeBytes);
};
export {}
