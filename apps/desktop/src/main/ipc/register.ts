// IPC registration — every handler validates sender frame, input schema,
// workspace ownership and Trust before touching the runtime. §3.2 / §6.3

import { ipcMain, dialog, BrowserWindow } from "electron";
import {
  validateApprovalResolve,
  validatePermissionModeSet,
  validateAuthSubmitKey,
  validateAuthRemoveKey,
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
import type { ProjectsStore } from "../projects-store.js";
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
  projects: ProjectsStore;
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
      // 记录项目树 + 启动恢复用 lastOpened；已有项目保持原位不跳动。
      opts.projects.add(cwd);
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

  // ── projects (saved workspaces + per-project session tree) ────────────────

  ipcMain.handle("projects.list", async (event): Promise<Result<unknown>> => {
    return wrap(() => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      // lastOpened：最近打开的项目（启动恢复用），与侧边栏显示顺序无关。
      return ok({ projects: opts.projects.list(), lastOpened: opts.projects.lastOpened() });
    });
  });

  ipcMain.handle("projects.sessions", async (event): Promise<Result<unknown>> => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      // Read-only metadata scan of app-owned session files; no trust needed.
      return ok(await opts.projects.listSessions());
    });
  });

  ipcMain.handle("projects.open", async (event, input): Promise<Result<unknown>> => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const cwd = (input as { cwd?: unknown } | undefined)?.cwd;
      if (typeof cwd !== "string") return fail("invalid_input", "cwd required");
      // Only saved projects can be reopened — the renderer selects among
      // main-known paths; it never supplies arbitrary paths (§4.1).
      if (!opts.projects.list().includes(cwd)) {
        return fail("denied", "unknown project");
      }
      const real = await opts.openWorkspace(cwd);
      // 仅更新 lastOpened；项目在侧边栏中的位置保持不变。
      opts.projects.add(real);
      return ok({ cwd: real, trust: opts.getWorkspace().trust });
    });
  });

  ipcMain.handle("projects.remove", async (event, input): Promise<Result<unknown>> => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const cwd = (input as { cwd?: unknown } | undefined)?.cwd;
      if (typeof cwd !== "string") return fail("invalid_input", "cwd required");
      // Only main-recorded projects can be forgotten (§4.1 spirit): the
      // renderer selects among known paths, never supplies arbitrary ones.
      if (!opts.projects.list().includes(cwd)) {
        return fail("not_found", "unknown project");
      }
      opts.projects.remove(cwd);
      return ok({ removed: true });
    });
  });

  ipcMain.handle("projects.reorder", async (event, input): Promise<Result<unknown>> => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const order = (input as { order?: unknown } | undefined)?.order;
      if (!Array.isArray(order) || order.some((x) => typeof x !== "string") || order.length === 0) {
        return fail("invalid_input", "order must be a non-empty string array");
      }
      opts.projects.reorder(order as string[]);
      return ok({ reordered: true });
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

  ipcMain.handle("auth.removeKey", async (event, input) => {
    return wrap(async () => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const v = validateAuthRemoveKey(input);
      if (!v.ok) return v;
      requireTrusted("restricted");
      const a = adapter();
      await a.removeApiKey(v.data.provider);
      return ok({ removed: true });
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

  // 会话级权限模式：default（默认权限）/ full（完全访问）。
  ipcMain.handle("permissions.setMode", async (event, input) => {
    return wrap(() => {
      if (!isPrimaryWindow(event)) return fail("denied", "bad sender");
      const v = validatePermissionModeSet(input);
      if (!v.ok) return v;
      requireTrusted("restricted");
      const a = adapter();
      // 经 adapter 入口切换：PermissionManager 生效的同时同步偏好记忆
      // （全局最后一次 + 当前项目目录），供新对话/切换会话恢复。
      a.setPermissionMode(v.data.mode);
      audit.enqueue({
        timestamp: Date.now(),
        sessionId: a.sessionId,
        toolCallId: "",
        toolName: "(permissions.setMode)",
        decision: "auto-allow",
        reason: `mode=${v.data.mode}`,
        inputSummary: { text: "", truncated: false, redacted: false },
      });
      return ok({ mode: v.data.mode });
    });
  });

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
        decision: v.data.decision === "deny" ? "deny" : v.data.decision,
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

