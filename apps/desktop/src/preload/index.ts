// Restricted preload — §3: contextBridge exposes ONLY concrete command wrappers
// and event subscription. No ipcRenderer, no event objects, no generic invoke/send.

import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentSnapshot,
  ApprovalResolveRequest,
  AuthBeginRequest,
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

const INVOKE_COMMANDS = new Set<Channel>([
  "workspace.pickAndOpen",
  "workspace.trust.set",
  "workspace.close",
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
  "approval.resolve",
]);

function invoke<T>(channel: Channel, payload?: unknown): Promise<T> {
  if (!INVOKE_COMMANDS.has(channel)) {
    return Promise.reject(new Error(`preload: channel not allowlisted: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

const api = {
  workspace: {
    pickAndOpen: (): Promise<Result<{ cwd: string; trust: string }>> =>
      invoke("workspace.pickAndOpen"),
    setTrust: (trust: WorkspaceTrustSetRequest["trust"]): Promise<Result<{ cwd: string; trust: string }>> =>
      invoke("workspace.trust.set", { trust } satisfies WorkspaceTrustSetRequest),
    close: (): Promise<Result<{ closed: true }>> => invoke("workspace.close"),
  },
  auth: {
    status: (): Promise<Result<AgentSnapshot["authState"]>> => invoke("auth.status"),
    begin: (provider: string): Promise<Result<{ oauthUrl?: string }>> =>
      invoke("auth.begin", { provider } satisfies AuthBeginRequest),
    submitKey: (provider: string, apiKey: string): Promise<Result<AgentSnapshot["authState"]>> =>
      invoke("auth.submitKey", { provider, apiKey } satisfies AuthSubmitKeyRequest),
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
    fork: (entryId: string): Promise<Result<{ sessionId: string }>> =>
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
  },
  approvals: {
    resolve: (
      requestId: string,
      sessionId: string,
      decision: ApprovalResolveRequest["decision"],
    ): Promise<Result<{ resolved: true }>> =>
      invoke("approval.resolve", { requestId, sessionId, decision } satisfies ApprovalResolveRequest),
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
