// Electron Main entry — security defaults §3, workspace state machine §4.1,
// failure/recovery §4.5.

import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { PermissionManager, createAuditSink } from "./agent/permission-manager.js";
import { PiAdapter } from "./agent/pi-adapter.js";
import { canonicalize, type AgentHost, type AgentHostPaths } from "./agent/host.js";
import type { AgentEvent } from "@hello-agent/shared";
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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
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

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
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
  const host = makeHost();
  const auditSink = createAuditSink(host.paths.auditFile);
  const permissions = new PermissionManager({
    getTrust: () => workspace.trust,
    getCwd: () => workspace.cwd,
    getSessionId: () => adapter?.sessionId ?? "",
    ttlMs: 60_000,
    onApprovalRequested: () => {},
    onApprovalResolved: () => {},
    audit: (r) => auditSink.enqueue(r),
  });

  async function ensureRuntime(): Promise<void> {
    if (!workspace.cwd || workspace.trust === "untrusted") {
      throw new Error("untrusted_workspace");
    }
    adapter = adapter ?? new PiAdapter(host, permissions);
    await adapter.create(workspace.cwd); // dispose + rebuild on cwd change (§4.5)
  }

  registerIpc({
    getWindow: () => win,
    getWorkspace: () => workspace,
    setTrust: (t) => {
      workspace.trust = t;
    },
    openWorkspace: async (rawPath) => {
      // §4.1 CanonicalizeCwd: realpath + accessibility; failure → error state.
      const real = canonicalize(rawPath);
      if (!real) throw new Error("invalid_input: cannot canonicalize workspace path");
      workspace.cwd = real;
      return real;
    },
    ensureRuntime,
    closeWorkspace: async () => {
      await adapter?.dispose();
      adapter = undefined;
      workspace.cwd = "";
      workspace.trust = "untrusted";
    },
    getAdapter: () => adapter,
    auditFile: host.paths.auditFile,
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  // §4.5: abort → cancel approvals → unsubscribe → dispose with timeouts.
  try {
    await adapter?.dispose();
  } finally {
    app.quit();
  }
});
