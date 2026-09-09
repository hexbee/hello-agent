/** Renderer-owned drafts; never submitted automatically after reload. */
export type PendingSend = {
  id: string;
  text: string;
  status: "sending" | "failed" | "uncertain";
  error?: string;
};
export type ConversationDraft = { text: string; pending?: PendingSend };
export type ConversationDrafts = Record<string, ConversationDraft>;
const STORAGE_KEY = "hello-agent:conversation-drafts:v1";

export function conversationKey(cwd: string, sessionId: string | undefined): string {
  return JSON.stringify([cwd, sessionId ?? ""]);
}

export function loadConversationDrafts(): ConversationDrafts {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const drafts: ConversationDrafts = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || typeof value.text !== "string") continue;
      const draft: ConversationDraft = { text: value.text };
      const p = value.pending;
      if (p && typeof p.id === "string" && typeof p.text === "string" &&
        ["sending", "failed", "uncertain"].includes(p.status)) {
        draft.pending = { id: p.id, text: p.text,
          status: p.status === "sending" ? "uncertain" : p.status,
          error: p.status === "sending" ? "窗口已重新加载，请先核对对话中的发送结果。" : typeof p.error === "string" ? p.error : undefined };
      }
      drafts[key] = draft;
    }
    return drafts;
  } catch { return {}; }
}

export function persistConversationDrafts(drafts: ConversationDrafts): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts)); }
  catch { /* Keep the in-memory draft if storage is unavailable or full. */ }
}
