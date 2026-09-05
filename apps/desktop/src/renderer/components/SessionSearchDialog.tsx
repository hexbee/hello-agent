import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Search, X } from "lucide-react";
import { cn } from "../lib/utils";

export type SearchSession = { id: string; title: string; project: string; modified: number };

/** Search the complete project catalog, independently of sidebar pagination/collapse. */
export function SessionSearchDialog({ sessions, onClose, onSelect }: {
  sessions: SearchSession[];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const results = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return sessions.filter((session) => {
      const text = `${session.title} ${session.project}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    }).sort((a, b) => b.modified - a.modified);
  }, [sessions, query]);
  const activeIndex = Math.max(0, results.findIndex((session) => session.id === selectedId));
  const active = results[activeIndex];

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    input.current?.focus();
    return () => {
      dialog.current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);

  const choose = (id: string) => { onClose(); onSelect(id); };
  return createPortal(
    <dialog ref={dialog} aria-label="搜索对话"
      className="fixed inset-x-0 top-[14vh] m-0 mx-auto w-[min(680px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-border bg-panel p-0 text-foreground shadow-2xl backdrop:bg-black/45"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      } }}>
      <div className="flex items-center gap-3 px-5 py-4">
        <Search aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <input ref={input} value={query} placeholder="搜索对话" aria-label="搜索对话标题或项目"
          role="combobox" aria-expanded="true" aria-controls="session-search-results" aria-autocomplete="list"
          aria-activedescendant={active ? `session-search-${activeIndex}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          onChange={(event) => { setQuery(event.target.value); setSelectedId(null); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (results.length) setSelectedId(results[(activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length]!.id);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (active) choose(active.id);
            }
          }} />
        <button type="button" aria-label="关闭搜索" onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="px-5 pb-2 pt-1 text-xs text-muted-foreground">对话</div>
      <div id="session-search-results" role="listbox" aria-label="对话搜索结果" className="max-h-[min(440px,55vh)] overflow-y-auto px-2 pb-2">
        {results.map((session, index) => (
          <div key={session.id} id={`session-search-${index}`} role="option" aria-selected={index === activeIndex}
            onMouseMove={() => setSelectedId(session.id)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(session.id)}
            className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm", index === activeIndex ? "bg-foreground/10 text-foreground" : "text-foreground/80")}>
            <MessageSquare aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            <span className="max-w-[30%] truncate text-xs text-muted-foreground" title={session.project}>{session.project}</span>
          </div>
        ))}
        {!results.length && <p role="status" className="px-3 py-10 text-center text-sm text-muted-foreground">{query.trim() ? "未找到匹配的对话" : "暂无对话，开始一个新对话吧"}</p>}
      </div>
    </dialog>, document.body,
  );
}
