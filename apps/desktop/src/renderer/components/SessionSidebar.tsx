import { useState } from "react";
import { store, useStore } from "../store";

function fmtTime(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function SessionSidebar() {
  const s = useStore();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [forkOpen, setForkOpen] = useState(false);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-2 px-3 py-3">
        <button
          className="flex-1 cursor-pointer rounded-lg bg-accent/90 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          onClick={() => void store.newSession()}
        >
          ＋ 新会话
        </button>
        <button
          className="cursor-pointer rounded-lg border border-border px-2 py-1.5 text-xs text-muted hover:text-fg"
          title="重命名当前会话"
          onClick={() => {
            setRenaming(true);
            setNameDraft(s.session?.name ?? "");
          }}
        >
          改名
        </button>
      </div>

      {renaming && (
        <div className="mx-3 mb-2 flex gap-1">
          <input
            autoFocus
            value={nameDraft}
            className="min-w-0 flex-1 rounded border border-border bg-panel-2 px-2 py-1 text-xs outline-none focus:border-accent"
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameDraft.trim()) {
                void store.renameSession(nameDraft.trim());
                setRenaming(false);
              } else if (e.key === "Escape") setRenaming(false);
            }}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {s.sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted">暂无历史会话</p>
        ) : (
          s.sessions.map((sess) => {
            const current = sess.file === s.session?.file;
            return (
              <div
                key={sess.file}
                className={`group mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                  current ? "bg-accent/15" : "hover:bg-panel-2"
                }`}
                onClick={() => void store.openSession(sess.file)}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{sess.name || sess.file.split("/").pop()}</div>
                  {sess.name && (
                    <div className="truncate text-[11px] text-muted">
                      {sess.file.split("/").pop()}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-muted">{fmtTime(sess.modified)}</span>
                <button
                  title="删除（移到废纸篓）"
                  className="hidden shrink-0 cursor-pointer text-xs text-muted group-hover:block hover:text-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("删除该会话？（移到系统废纸篓）")) {
                      void store.deleteSession(sess.file);
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>

      {s.forkCandidates.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <button
            className="flex w-full cursor-pointer items-center justify-between text-xs text-muted hover:text-fg"
            onClick={() => setForkOpen(!forkOpen)}
          >
            从历史分叉 <span>{forkOpen ? "▾" : "▸"}</span>
          </button>
          {forkOpen && (
            <div className="mt-1 max-h-40 overflow-y-auto">
              {s.forkCandidates.map((c) => (
                <button
                  key={c.entryId}
                  className="block w-full cursor-pointer truncate rounded px-1 py-1 text-left text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
                  title={c.text}
                  onClick={() => void store.fork(c.entryId)}
                >
                  ⎇ {c.text.slice(0, 40) || "(空消息)"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border px-3 py-2">
        <button
          className="cursor-pointer text-xs text-muted hover:text-fg"
          onClick={() => void store.closeWorkspace()}
        >
          关闭工作区
        </button>
      </div>
    </aside>
  );
}
