// Typed access to the restricted preload bridge. The renderer never touches
// raw IPC — every call goes through window.helloAgent (§3.1).

import type { HelloAgentApi } from "../preload/index";

declare global {
  interface Window {
    helloAgent: HelloAgentApi;
  }
}

export const api = (): HelloAgentApi => {
  const a = window.helloAgent;
  if (!a) throw new Error("preload bridge missing");
  return a;
};

/** Unwrap a Result; throw the CommandError as an Error with code prefix. */
export function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): T {
  if (r.ok) return r.data;
  throw new Error(`${r.error.code}: ${r.error.message}`);
}
