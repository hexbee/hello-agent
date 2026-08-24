// IPC registration — every handler validates sender frame, input schema,
// workspace ownership and Trust before touching the runtime. §3.2 / §6.3

import { ipcMain, dialog, BrowserWindow } from "electron";
import {
  validateApprovalResolve,
  validateAuthSubmitKey,
  validateModelsSelect,
  validateSessionDelete,
  validateSessionFork,
  validateSessionOpen,
  validateSessionRename,
  validateWorkspaceTrustSet,
  validateAgentPrompt,
  type CommandError,
  type Result,
} from "@hello-agent/shared";
import type { PiAdapter } from "../agent/pi-adapter.js";
import { createAuditSink } from "../agent/permission-manager.js";

export interface WorkspaceState {
  cwd: string; // canonical
  trust: "untrusted" | "restricted" | "trusted";
}

export function registerIpc(opts: {
  getWindow(): BrowserWindow | undefined;
  getWorkspace(): WorkspaceState;
  setTrust(trust: WorkspaceState["trust"]): void;
  /** Canonicalize + validate the chosen path; returns canonical cwd or throws. */
  openWorkspace(rawPath: string): Promise<string>;
  /** Create/replace the PiAdapter for the current workspace+trust. */
  ensureRuntime(): Promise<void>;
  closeWorkspace(): Promise<void>;
  getAdapter(): PiAdapter | undefined;
  auditFile: string | undefined;
}): void {
  const audit = createAuditSink(opts.auditFile);
  const ok = <T>(data: T): Result<T> => ({ ok: true, data });
  const fail = (code: CommandError["code"], message: string): Result<never> => ({
    ok: false,
    error: { code, message },
  });

  const isPrimaryWindow = (event: Electron.IpcMainInvokeEvent): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win != null && win === opts.getWindow();
  };

  const adapter = (): PiAdapter => {
    const a = opts.getAdapter();
    if (!a) throw new Error("no_runtime");
    return a;
  };

  const requireTrusted = (min: "restricted" | "trusted"): void => {
    const t = opts.getWorkspace().trust;
    if (t === "untrusted") throw new Error("untrusted_workspace");
    if (min === "trusted" && t !== "trusted") throw new Error("denied");
  };

  const wrap = async (fn: () => Promise<Result<unknown>> | Result<unknown>): Promise<Result<unknown>> => {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const code of [
        "no_runtime",
        "untrusted_workspace",
        "busy",
        "auth_required",
        "not_found",
        "denied",
      ] as const) {
        if (message.startsWith(code)) return fail(code, message);
      }
      console.error("[ipc]", message);
      return fail("internal", "internal error"); // never leak internals to Renderer
    }
  };

  // ── workspace ──────────────────────────────────────────────────────────────

  ipcMain.handle("workspace.pickAndOpen", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win!, {
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return fail("invalid_input", "no directory selected");
      }
      // §4.1: Main canonicalizes; Renderer never supplies paths.
      const cwd = await opts.openWorkspace(result.filePaths[0]!);
      return ok({ cwd, trust: opts.getWorkspace().trust });
    });
  });

  ipcMain.handle("workspace.trust.set", async (event, input): Promise<Result<unknown>> => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const v = validateWorkspaceTrustSet(input);
      if (!v.ok) return v;
      opts.setTrust(v.data.trust);
      await opts.ensureRuntime(); // §4.1: TrustCheck → ConfigureAuth → CreateRuntime
      return ok({ cwd: opts.getWorkspace().cwd, trust: v.data.trust });
    });
  });

  ipcMain.handle("workspace.close", async (event): Promise<Result<unknown>> => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      await opts.closeWorkspace();
      return ok({ closed: true });
    });
  });

  // ── auth / models ──────────────────────────────────────────────────────────

  ipcMain.handle("auth.status", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const a = adapter();
      return ok(await a.authState());
    });
  });

  ipcMain.handle("auth.begin", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      // v0.1: OAuth deferred (§1.3 明确不包含); renderer only offers API key.
      void input;
      return ok({});
    });
  });

  ipcMain.handle("auth.submitKey", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const v = validateAuthSubmitKey(input);
      if (!v.ok) return v;
      requireTrusted("restricted");
      const a = adapter();
      // §8: verify before accepting; adapter rolls back on failure. The raw
      // key is never echoed back or logged.
      await a.submitApiKey(v.data.provider, v.data.apiKey);
      return ok(await a.authState());
    });
  });

  ipcMain.handle("auth.cancel", async (event) => {
    return wrap(() => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      return ok({ cancelled: true });
    });
  });

  ipcMain.handle("models.list", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      return ok(await adapter().listModels());
    });
  });

  ipcMain.handle("models.select", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      const v = validateModelsSelect(input);
      if (!v.ok) return v;
      return ok({ selected: await adapter().selectModel(v.data.ref) });
    });
  });

  // ── sessions ───────────────────────────────────────────────────────────────

  ipcMain.handle("session.list", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      return ok(await adapter().listSessions());
    });
  });

  ipcMain.handle("session.open", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      const v = validateSessionOpen(input);
      if (!v.ok) return v;
      return ok(await adapter().openSession(v.data.path));
    });
  });

  ipcMain.handle("session.new", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      return ok(await adapter().newSession());
    });
  });

  ipcMain.handle("session.fork", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      const v = validateSessionFork(input);
      if (!v.ok) return v;
      return ok(await adapter().forkSession(v.data.entryId));
    });
  });

  ipcMain.handle("session.rename", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      const v = validateSessionRename(input);
      if (!v.ok) return v;
      adapter().renameSession(v.data.name);
      return ok({ renamed: true });
    });
  });

  ipcMain.handle("session.delete", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      const v = validateSessionDelete(input);
      if (!v.ok) return v;
      await adapter().deleteSession(v.data.path);
      return ok({ deleted: true });
    });
  });

  // ── agent ──────────────────────────────────────────────────────────────────

  ipcMain.handle("agent.prompt", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      const v = validateAgentPrompt(input);
      if (!v.ok) return v;
      return ok(await adapter().prompt(v.data.text));
    });
  });

  ipcMain.handle("agent.abort", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      await adapter().abort();
      return ok({ aborted: true });
    });
  });

  // §4.5 explicit recovery: dispose broken runtime, same-cwd rebuild, restore
  // latest usable session. Never auto-triggered by Renderer.
  ipcMain.handle("agent.rebuild", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      requireTrusted("restricted");
      const a = opts.getAdapter();
      if (!a) return fail("no_runtime", "no workspace open");
      const r = await a.rebuild();
      return ok(r);
    });
  });

  ipcMain.handle("agent.snapshot", async (event) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const a = opts.getAdapter();
      if (!a) return fail("no_runtime", "no workspace open");
      const snap = a.buildSnapshot(a.permissions.listPending());
      Object.assign(snap, await a.fullAuthModels());
      return ok(snap);
    });
  });

  // ── permissions ────────────────────────────────────────────────────────────

  ipcMain.handle("approval.resolve", async (event, input) => {
    return wrap(() => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const v = validateApprovalResolve(input);
      if (!v.ok) return v;
      const a = adapter();
      // §6.3: verify request belongs to the CURRENT session before resolving.
      if (v.data.sessionId !== a.sessionId) return fail("denied", "stale sessionId");
      const r = a.permissions.resolveApproval(
        v.data.requestId,
        v.data.sessionId,
        v.data.decision,
      );
      if (!r.ok) return fail("denied", r.reason);
      audit.enqueue({
        timestamp: Date.now(),
        sessionId: v.data.sessionId,
        toolCallId: "",
        toolName: "(approval.resolve)",
        decision: v.data.decision === "allow" ? "allow" : "deny",
        reason: `requestId=${v.data.requestId}`,
        inputSummary: { text: "", truncated: false, redacted: false },
      });
      return ok({ resolved: true });
    });
  });

  // ── dev-only ───────────────────────────────────────────────────────────────

  ipcMain.handle("dev.stressDeltas", async (event, input) => {
    return wrap(() => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      if (!process.env.SPIKE_DEV) return fail("denied", "dev commands disabled");
      const count = (input as { count?: unknown }).count as number;
      const sizeBytes = (input as { sizeBytes?: unknown }).sizeBytes as number;
      adapter().injectDevDeltas(count, sizeBytes);
      return ok({ started: true });
    });
  });
}

