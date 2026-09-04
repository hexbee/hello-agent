// Restricted preload — §3: contextBridge exposes ONLY concrete command wrappers
// and event subscription. No ipcRenderer, no event objects, no generic invoke/send.

// 捕获 preload 上下文的错误（contextIsolation: true 时主进程无法自动覆盖 preload）。
// 沙箱化 preload 不能 require 外部 node_modules，@sentry/electron 由 electron-vite
// 打进 bundle（见 electron.vite.config.ts preload.externalizeDepsPlugin exclude）。
import * as Sentry from "@sentry/electron/renderer";

Sentry.init(); // 配置（dsn/采样等）由主进程经 IPC 下发，renderer 侧无需重复传参

import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentRebuildResult,
  AgentSnapshot,
  ApprovalResolveRequest,
  AuthBeginRequest,
  AuthRemoveKeyRequest,
  AuthSubmitKeyRequest,
  ModelsSelectRequest,
  Result,
  SessionDeleteRequest,
  SessionForkRequest,
  SessionOpenRequest,
  SessionRenameRequest,
  WorkspaceTrustSetRequest,
} from "@hello-agent/shared";

type Channel = string;

export interface ProjectSessionInfo {
  file: string;
  name?: string;
  modified?: number;
}

export interface ProjectSessions {
  cwd: string;
  name: string;
  sessions: ProjectSessionInfo[];
}

const INVOKE_COMMANDS = new Set<Channel>([
  "workspace.pickAndOpen",
  "workspace.trust.set",
  "workspace.close",
  "projects.list",
  "projects.sessions",
  "projects.open",
  "projects.remove",
  "projects.reorder",
  "auth.status",
  "auth.begin",
  "auth.submitKey",
  "auth.cancel",
  "models.list",
  "models.select",
  "session.list",
  "session.open",
  "session.new",
  "session.fork",
  "session.rename",
  "session.delete",
  "agent.prompt",
  "agent.abort",
  "agent.snapshot",
  "agent.rebuild",
  "permissions.setMode",
  "approval.resolve",
]);

function invoke<T>(channel: Channel, payload?: unknown): Promise<T> {
  if (!INVOKE_COMMANDS.has(channel)) {
    return Promise.reject(new Error(`preload: channel not allowlisted: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

const api = {
  /** 宿主平台（darwin/win32/linux）：renderer 据此做红绿灯区域等平台适配。 */
  platform: process.platform,
  workspace: {
    pickAndOpen: (): Promise<Result<{ cwd: string; trust: string }>> =>
      invoke("workspace.pickAndOpen"),
    setTrust: (trust: WorkspaceTrustSetRequest["trust"]): Promise<Result<{ cwd: string; trust: string }>> =>
      invoke("workspace.trust.set", { trust } satisfies WorkspaceTrustSetRequest),
    close: (): Promise<Result<{ closed: true }>> => invoke("workspace.close"),
  },
  projects: {
    list: (): Promise<Result<{ projects: string[]; lastOpened: string | null }>> =>
      invoke("projects.list"),
    sessions: (): Promise<Result<ProjectSessions[]>> => invoke("projects.sessions"),
    open: (cwd: string): Promise<Result<{ cwd: string; trust: string }>> =>
      invoke("projects.open", { cwd }),
    remove: (cwd: string): Promise<Result<{ removed: true }>> =>
      invoke("projects.remove", { cwd }),
    reorder: (order: string[]): Promise<Result<{ reordered: true }>> =>
      invoke("projects.reorder", { order }),
  },
  auth: {
    status: (): Promise<Result<AgentSnapshot["authState"]>> => invoke("auth.status"),
    begin: (provider: string): Promise<Result<{ oauthUrl?: string }>> =>
      invoke("auth.begin", { provider } satisfies AuthBeginRequest),
    submitKey: (provider: string, apiKey: string): Promise<Result<AgentSnapshot["authState"]>> =>
      invoke("auth.submitKey", { provider, apiKey } satisfies AuthSubmitKeyRequest),
    removeKey: (provider: string): Promise<Result<{ removed: true }>> =>
      invoke("auth.removeKey", { provider } satisfies AuthRemoveKeyRequest),
    cancel: (): Promise<Result<{ cancelled: true }>> => invoke("auth.cancel"),
  },
  models: {
    list: (): Promise<Result<AgentSnapshot["models"]>> => invoke("models.list"),
    select: (ref: string): Promise<Result<{ selected: string | null }>> =>
      invoke("models.select", { ref } satisfies ModelsSelectRequest),
  },
  session: {
    list: (): Promise<Result<Array<{ file: string; name?: string; modified?: number }>>> =>
      invoke("session.list"),
    open: (path: string): Promise<Result<{ sessionId: string }>> =>
      invoke("session.open", { path } satisfies SessionOpenRequest),
    create: (): Promise<Result<{ sessionId: string }>> => invoke("session.new"),
    fork: (
      entryId: string | null,
    ): Promise<Result<{ sessionId: string; file: string; name?: string }>> =>
      invoke("session.fork", { entryId } satisfies SessionForkRequest),
    rename: (name: string): Promise<Result<{ renamed: true }>> =>
      invoke("session.rename", { name } satisfies SessionRenameRequest),
    delete: (path: string): Promise<Result<{ deleted: true }>> =>
      invoke("session.delete", { path } satisfies SessionDeleteRequest),
  },
  agent: {
    prompt: (text: string): Promise<Result<{ accepted: boolean }>> =>
      invoke("agent.prompt", { text }),
    abort: (): Promise<Result<{ aborted: true }>> => invoke("agent.abort"),
    snapshot: (): Promise<Result<AgentSnapshot>> => invoke("agent.snapshot"),
    rebuild: (): Promise<Result<AgentRebuildResult>> => invoke("agent.rebuild"),
  },
  approvals: {
    resolve: (
      requestId: string,
      sessionId: string,
      decision: ApprovalResolveRequest["decision"],
    ): Promise<Result<{ resolved: true }>> =>
      invoke("approval.resolve", { requestId, sessionId, decision } satisfies ApprovalResolveRequest),
  },
  permissions: {
    setMode: (mode: "default" | "full"): Promise<Result<{ mode: "default" | "full" }>> =>
      invoke("permissions.setMode", { mode }),
  },
  events: {
    /** Single subscription point; Renderer never touches raw IPC. */
    subscribe(cb: (event: unknown) => void): () => void {
      const listener = (_e: unknown, event: unknown): void => cb(event);
      ipcRenderer.on("agent.event", listener);
      return () => ipcRenderer.removeListener("agent.event", listener);
    },
  },
};

contextBridge.exposeInMainWorld("helloAgent", api);

export type HelloAgentApi = typeof api;
