import { useState } from "react";
import { store, useStore } from "../store";

/** Editing pauses the queue, so a message cannot leave while its text is edited. */
export function PromptQueue() {
  const { promptQueue: queue } = useStore();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!queue.items.length) return null;

  const act = async (action: () => Promise<boolean>) => {
    if (busy) return false;
    setBusy(true);
    try { return await action(); }
    finally { setBusy(false); }
  };

  return (
    <section aria-label="待发送消息" className="mb-2 rounded-xl border border-border bg-panel text-sm">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="font-medium">待发送 · {queue.items.length}</span>
        <button type="button" className="text-accent disabled:opacity-50" disabled={busy || !!editing}
          onClick={() => void act(() => store.controlQueue(!queue.paused))}>
          {queue.paused ? "继续队列" : "暂停后续"}
        </button>
      </div>
      <p className="px-3 pb-2 text-xs text-muted-foreground" role="status">
        {queue.paused ? "队列已暂停，消息会保留，继续后按顺序发送。" : "当前任务结束后依次发送。编辑会暂停后续消息。"}
      </p>
      <ol className="max-h-64 overflow-y-auto border-t border-border">
        {queue.items.map((item, index) => (
          <li key={item.id} className="border-b border-border p-3 last:border-b-0">
            <div className="mb-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{index + 1} · {item.status === "sending" ? "正在发送" : item.status === "failed" ? "未发送" : item.status === "uncertain" ? "发送结果待确认" : "等待发送"}</span>
              <div className="flex shrink-0 gap-3">
                {item.status !== "sending" && item.status !== "uncertain" && (
                  <button type="button" disabled={busy || !!editing} onClick={() => void act(async () => {
                    if (!await store.controlQueue(true)) return false;
                    const current = store.getState().promptQueue.items.find((entry) => entry.id === item.id);
                    if (!current || current.status === "sending") return false;
                    setEditing({ id: current.id, text: current.text });
                    return true;
                  })}>编辑</button>
                )}
                <button type="button" disabled={busy || item.status === "sending" || !!editing}
                  onClick={() => void act(() => store.removeQueuedPrompt(item.id))}>
                  {item.status === "uncertain" ? "已核对，移除" : "取消"}
                </button>
              </div>
            </div>
            {editing?.id === item.id ? (
              <div>
                <textarea aria-label="编辑待发送消息" value={editing.text} maxLength={100_000} rows={3}
                  className="w-full resize-y rounded-lg border border-border bg-background p-2 focus:outline-accent"
                  onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
                <div className="mt-2 flex gap-3">
                  <button type="button" className="text-accent disabled:opacity-50" disabled={busy || !editing.text.trim()}
                    onClick={() => void act(async () => {
                      const saved = await store.editQueuedPrompt(item.id, editing.text);
                      if (saved) setEditing(null);
                      return saved;
                    })}>保存</button>
                  <button type="button" disabled={busy} onClick={() => setEditing(null)}>取消编辑</button>
                </div>
              </div>
            ) : <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-sans">{item.text}</pre>}
            {item.error && <p className="mt-1 text-xs text-muted-foreground">{item.error}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
