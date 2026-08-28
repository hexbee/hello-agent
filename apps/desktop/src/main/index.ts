// Electron Main entry — security defaults §3, workspace state machine §4.1,
// failure/recovery §4.5.

import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PermissionManager, createAuditSink } from "./agent/permission-manager.js";
import { PiAdapter } from "./agent/pi-adapter.js";
import { canonicalize, type AgentHost, type AgentHostPaths } from "./agent/host.js";
import { SafeStorageCredentialStore } from "./auth/credential-store.js";
import { TrustStore } from "./trust-store.js";
import { ProjectsStore } from "./projects-store.js";
import { SessionPrefsStore } from "./session-prefs.js";
import type { AgentEvent } from "@hello-agent/shared";
import { APPROVAL_TTL_MS } from "@hello-agent/shared";
import { registerIpc, type WorkspaceState } from "./ipc/register.js";

const SPIKE_DATA_DIR = process.env.SPIKE_DATA_DIR; // probes override this

function dataDir(): string {
  const dir = SPIKE_DATA_DIR ?? app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function hostPaths(): AgentHostPaths {
  const dir = dataDir();
  const agentDir = join(dir, "pi-agent"); // §4.3 app-private agentDir
  for (const sub of ["", "sessions"]) {
    mkdirSync(sub ? join(agentDir, sub) : agentDir, { recursive: true });
  }
  return {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    auditFile: join(dir, "audit.jsonl"),
  };
}

let win: BrowserWindow | undefined;
let adapter: PiAdapter | undefined;
const workspace: WorkspaceState = { cwd: "", trust: "untrusted" };
// §4.2 persisted Trust records, keyed by canonical workspace path.
const trustStore = new TrustStore(join(dataDir(), "trust.json"));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    // macOS 无边框：隐藏系统标题栏，红绿灯嵌到侧边栏顶部（renderer 预留
    // 顶部拖拽条并标记 app-drag），内容真正顶到窗口顶部。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true, // §3 frozen defaults
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // §3.3 strict navigation guards
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAllowedUrl(url)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // electron-vite 5 注入的是 ELECTRON_RENDERER_URL（不是 VITE_DEV_SERVER_URL）。
  // 变量名写错会静默回退到 out/renderer 旧构建 —— 曾导致 renderer 修复长期不生效。
  const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    console.log("[boot] renderer 来源: dev server", devServerUrl);
    void win.loadURL(devServerUrl);
  } else {
    console.log("[boot] renderer 来源: out/renderer/index.html (file build) —— dev server 未启动？renderer 可能是旧代码！");
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // §10.6 automated sandbox verification: run checks in the renderer MAIN
  // world (executeJavaScript bypasses preload), write results, quit.
  if (process.env.SPIKE_SANDBOX_PROBE && process.env.SPIKE_PROBE_OUT) {
    const diag: string[] = [];
    win.webContents.on("preload-error", (_e, _p, err) => diag.push(`preload-error: ${err}`));
    win.webContents.on("console-message", (_e, _lvl, msg) => diag.push(`console: ${msg}`));
    (win as unknown as { __diag: string[] }).__diag = diag;
    win.webContents.once("did-finish-load", () => {
      void win!
        .webContents
        .executeJavaScript(
          `JSON.stringify({
            hasNodeRequire: typeof require !== 'undefined',
            hasProcess: typeof process !== 'undefined',
            hasIpcRenderer: typeof ipcRenderer !== 'undefined',
            hasSpikeBridge: typeof window.helloAgent === 'object' && window.helloAgent !== null,
            noGenericInvoke: window.helloAgent.invoke === undefined && window.helloAgent.send === undefined,
          })`,
        )
        .then((json) => {
          const extra = JSON.parse(json) as Record<string, unknown>;
          const result = { ...extra, diag };
          writeFileSync(process.env.SPIKE_PROBE_OUT!, JSON.stringify(result, null, 2));
          app.quit();
        })
        .catch((e) => {
          writeFileSync(
            process.env.SPIKE_PROBE_OUT!,
            JSON.stringify({ error: String(e), diag }, null, 2),
          );
          app.quit();
        });
    });
  }
  // 临时 UI 探针（SPIKE_UI_PROBE=输出路径）：验证侧边栏折叠按钮的几何与状态链路。
  if (process.env.SPIKE_UI_PROBE) {
    win.webContents.once("did-finish-load", () => {
      void win!
        .webContents
        .executeJavaScript(`(async () => {
          const btn = document.querySelector('[data-slot="sidebar-trigger"]');
          if (!btn) return JSON.stringify({ found: false });
          const r = btn.getBoundingClientRect();
          const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
          const top = document.elementFromPoint(cx, cy);
          const slot = document.querySelector('[data-slot="sidebar"]');
          const before = slot ? slot.getAttribute("data-state") : null;
          btn.click();
          await new Promise((res) => setTimeout(res, 800));
          const afterCollapse = slot ? slot.getAttribute("data-state") : null;
          const topAfterCollapse = document.elementFromPoint(cx, cy);
          btn.click();
          await new Promise((res) => setTimeout(res, 800));
          const afterExpand = slot ? slot.getAttribute("data-state") : null;
          return JSON.stringify({
            found: true,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            topAtPoint: top ? top.tagName + " " + String(top.className).slice(0, 100) : null,
            before, afterCollapse,
            topAfterCollapse: topAfterCollapse
              ? topAfterCollapse.tagName + " " + String(topAfterCollapse.className).slice(0, 100)
              : null,
            afterExpand,
          });
        })()`)
        .then((json) => {
          writeFileSync(process.env.SPIKE_UI_PROBE!, json + "\n");
          app.quit();
        })
        .catch((e) => {
          writeFileSync(process.env.SPIKE_UI_PROBE!, JSON.stringify({ error: String(e) }) + "\n");
          app.quit();
        });
    });
  }
}

function isAllowedUrl(url: string): boolean {
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev && url.startsWith(dev)) return true;
  return url.startsWith("file://") && url.includes("renderer/index.html");
}

function makeHost(): AgentHost {
  const paths = hostPaths();
  return {
    paths,
    getCwd: () => workspace.cwd,
    getTrust: () => workspace.trust,
    emit: (event: AgentEvent) => {
      // IPC fan-out happens here; Renderer detects gaps via sequence. §6.1
      if (win && !win.isDestroyed()) win.webContents.send("agent.event", event);
    },
    getEnvKey: (provider) => {
      const map: Record<string, string | undefined> = {
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        google: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        "openrouter": process.env.OPENROUTER_API_KEY,
      };
      return map[provider];
    },
    // §1.3 recoverable delete — OS trash, not unlink.
    moveToTrash: async (p) => {
      if (!p.startsWith(realpathSync(dataDir()))) return false; // only app-owned files
      try {
        await shell.trashItem(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

app.whenReady().then(async () => {
  // §10.9 deep probe inside the PACKAGED product (asar/unpack context):
  // credential store roundtrip + runtime creation + session persistence.
  if (process.env.SPIKE_PKG_PROBE && process.env.SPIKE_PROBE_OUT) {
    void runPackagedProbe();
    return;
  }

  trustStore.load();

  // §8 — app-owned credential store; raw keys never leave Main.
  const credentialStore = new SafeStorageCredentialStore(join(dataDir(), "credentials.json"));
  const host = makeHost();
  host.credentials = credentialStore;
  host.credentialMeta = (providerId) => credentialStore.describe(providerId);
  // §4.5 watchdog — ADR mitigation: stalled agent → failed + abort.
  host.watchdogTimeoutMs = 180_000;
  const auditSink = createAuditSink(host.paths.auditFile);
  // Opened projects, persisted for launch-time restore + per-project session tree.
  const projectsStore = new ProjectsStore(join(dataDir(), "projects.json"), host.paths.sessionsDir);
  // 全局最后一次 + 按项目目录的权限/模型偏好（新对话继承、切换会话恢复）。
  const sessionPrefs = new SessionPrefsStore(join(dataDir(), "session-prefs.json"));
  const permissions = new PermissionManager({
    getTrust: () => workspace.trust,
    getCwd: () => workspace.cwd,
    getSessionId: () => adapter?.sessionId ?? "",
    ttlMs: APPROVAL_TTL_MS,
    onApprovalRequested: (p) => adapter?.emitApprovalRequested(p),
    onApprovalResolved: (p, decision) => adapter?.emitApprovalResolved(p.requestId, decision),
    audit: (r) => auditSink.enqueue(r),
  });

  async function ensureRuntime(): Promise<void> {
    if (!workspace.cwd || workspace.trust === "untrusted") {
      throw new Error("untrusted_workspace");
    }
    adapter = adapter ?? new PiAdapter(host, permissions, { prefs: sessionPrefs });
    await adapter.create(workspace.cwd); // dispose + rebuild on cwd change (§4.5)
  }

  registerIpc({
    getWindow: () => win,
    getWorkspace: () => workspace,
    setTrust: (t) => {
      workspace.trust = t;
      if (workspace.cwd) {
        // §4.2: persist grants; IPC validator only admits restricted/trusted,
        // but fail-closed in case the surface ever widens.
        if (t === "untrusted") trustStore.revoke(workspace.cwd);
        else trustStore.grant(workspace.cwd, t);
      }
    },
    openWorkspace: async (rawPath) => {
      // §4.1 CanonicalizeCwd: realpath + accessibility; failure → error state.
      const real = canonicalize(rawPath);
      if (!real) throw new Error("invalid_input: cannot canonicalize workspace path");
      workspace.cwd = real;
      // 打开即信任：不再有信任级别确认弹窗，任何被打开的目录都直接视为
      // 完全信任并进入 CreateRuntime。同步持久化授权记录，保持 trust.json
      // 与实际状态一致（旧的 restricted 记录也被提升为 trusted）。
      workspace.trust = "trusted";
      trustStore.grant(real, "trusted");
      await ensureRuntime();
      return real;
    },
    ensureRuntime,
    closeWorkspace: async () => {
      await adapter?.dispose();
      adapter = undefined;
      workspace.cwd = "";
      workspace.trust = "untrusted"; // record stays on disk for next open
    },
    getAdapter: () => adapter,
    auditFile: host.paths.auditFile,
    projects: projectsStore,
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});


/** §10.9 — packaged-product deep probe: run the full agent stack inside the
 * asar/unpack context, write JSON results to SPIKE_PROBE_OUT, then quit. */
async function runPackagedProbe(): Promise<void> {
  const out = process.env.SPIKE_PROBE_OUT!;
  const result: Record<string, unknown> = {};
  let adapter: PiAdapter | undefined;
  try {
    // 1. Credential store roundtrip via safeStorage.
    const paths = hostPaths();
    const credFile = join(paths.agentDir, "credentials.json");
    const store = new SafeStorageCredentialStore(credFile);
    const key = "sk-pkg-probe-0000000000001234";
    await store.modify("deepseek", async () => ({ type: "api_key" as const, key }));
    result.credentialStored = store.describe("deepseek") != null;
    result.credentialEncrypted = !readFileSync(credFile, "utf8").includes(key);

    // 2. Runtime creation with the unpacked pi subtree + session persistence.
    const cwd = mkdtempSync(join(tmpdir(), "pkg-probe-"));
    const probeHost: AgentHost = {
      paths,
      getCwd: () => cwd,
      getTrust: () => "trusted",
      emit: () => {},
      getEnvKey: () => undefined,
      credentials: store,
      credentialMeta: (id) => store.describe(id),
      moveToTrash: async (p) => shell.trashItem(p).then(() => true).catch(() => false),
      watchdogTimeoutMs: 60_000,
    };
    const permissions = new PermissionManager({
      getTrust: () => "trusted",
      getCwd: () => cwd,
      getSessionId: () => adapter?.sessionId ?? "",
      ttlMs: 10_000,
      onApprovalRequested: () => {},
      onApprovalResolved: () => {},
      audit: () => {},
    });
    adapter = new PiAdapter(probeHost, permissions);
    await adapter.create(cwd);
    result.runtimeCreated = !!adapter.sessionId;
    result.extensionBound = permissions.bindCount >= 1;

    await adapter.newSession();
    result.sessionPersisted = !!adapter.sessionFilePath();

    const models = await adapter.listModels();
    result.modelsCatalog = Array.isArray(models) ? models.length : -1;
  } catch (e) {
    result.error = String(e);
  } finally {
    await adapter?.dispose().catch(() => undefined);
  }
  writeFileSync(out, JSON.stringify(result, null, 2));
  app.quit();
}

app.on("window-all-closed", async () => {
  // §4.5: abort → cancel approvals → unsubscribe → dispose with timeouts.
  try {
    await adapter?.dispose();
  } finally {
    app.quit();
  }
});
