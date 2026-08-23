// Restricted preload — §3: contextBridge exposes ONLY concrete command wrappers
// and event subscription. No ipcRenderer, no event objects, no generic invoke/send.

import { contextBridge, ipcRenderer } from "electron";

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
  return ipcRenderer.invoke(channel, payload);
}

const api = {
  workspace: {
    pickAndOpen: () => invoke("workspace.pickAndOpen"),
    setTrust: (trust: "restricted" | "trusted") =>
      invoke("workspace.trust.set", { trust }),
    close: () => invoke("workspace.close"),
  },
  auth: {
    status: () => invoke("auth.status"),
    begin: (provider: string) => invoke("auth.begin", { provider }),
    submitKey: (provider: string, apiKey: string) =>
      invoke("auth.submitKey", { provider, apiKey }),
    cancel: () => invoke("auth.cancel"),
  },
  models: {
    list: () => invoke("models.list"),
    select: (ref: string) => invoke("models.select", { ref }),
  },
  session: {
    list: () => invoke("session.list"),
    open: (path: string) => invoke("session.open", { path }),
    create: () => invoke("session.new"),
    fork: (entryId: string) => invoke("session.fork", { entryId }),
    rename: (name: string) => invoke("session.rename", { name }),
    delete: (path: string) => invoke("session.delete", { path }),
  },
  agent: {
    prompt: (text: string) => invoke("agent.prompt", { text }),
    abort: () => invoke("agent.abort"),
    snapshot: () => invoke("agent.snapshot"),
  },
  approvals: {
    resolve: (requestId: string, sessionId: string, decision: "allow" | "deny") =>
      invoke("approval.resolve", { requestId, sessionId, decision }),
  },
  dev: {
    stressDeltas: (count: number, sizeBytes: number) =>
      invoke("dev.stressDeltas", { count, sizeBytes }),
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

contextBridge.exposeInMainWorld("spike", api);

export type SpikeApi = typeof api;
