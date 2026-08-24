import { useRef, useState } from "react";
import { store, useStore } from "../store";

export function Composer() {
  const s = useStore();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const running = s.agentState === "running";

  const send = (): void => {
    if (!text.trim() || running) return;
    void store.prompt(text);
    setText("");
    requestAnimationFrame(() => ref.current?.focus());
  };

  return (
    <div className="py-3">
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-panel p-2 focus-within:border-accent/60">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={running ? "Agent 正在运行…" : "输入消息（Enter 发送，Shift+Enter 换行）"}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none"
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {running ? (
          <button
            className="cursor-pointer rounded-xl bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            onClick={() => void store.abort()}
          >
            停止
          </button>
        ) : (
          <button
            className="cursor-pointer rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!text.trim() || s.trust === "untrusted"}
            onClick={send}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
