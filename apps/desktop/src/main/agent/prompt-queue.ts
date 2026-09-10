import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_QUEUED_PROMPTS, type PromptQueueSnapshot, type QueuedPrompt } from "@hello-agent/shared";

type SavedQueue = PromptQueueSnapshot & { seen: string[] };
const emptyQueue = (): SavedQueue => ({ revision: 0, paused: false, items: [], seen: [] });

/** App-owned follow-up queue. Claim is persisted BEFORE invoking the SDK.
 * On restart, claimed messages become uncertain and every queue is paused. */
export class PromptQueueStore {
  private queues: Record<string, SavedQueue> = {};

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data.version !== 1 || !data.queues || typeof data.queues !== "object") return;
      for (const [key, raw] of Object.entries(data.queues)) {
        const q = raw as SavedQueue;
        if (!q || !Array.isArray(q.items) || !Array.isArray(q.seen) ||
          !q.seen.every((id) => typeof id === "string") || !Number.isSafeInteger(q.revision)) continue;
        const items: QueuedPrompt[] = q.items.filter((item) => item && typeof item.id === "string" &&
          typeof item.text === "string" && item.text.length <= 100_000 && Number.isFinite(item.createdAt) &&
          ["queued", "sending", "failed", "uncertain"].includes(item.status)).map((item) => ({
            id: item.id, text: item.text, createdAt: item.createdAt,
            status: item.status === "sending" ? "uncertain" : item.status,
            error: item.status === "sending" ? "应用已重启，请核对这条消息是否已执行，再将它移出队列。"
              : typeof item.error === "string" ? item.error : undefined,
          }));
        this.queues[key] = { revision: q.revision + 1, paused: true, items, seen: q.seen };
      }
    } catch { /* First launch or invalid queue file: never schedule unknown data. */ }
  }

  snapshot(key: string): PromptQueueSnapshot {
    const { seen: _seen, ...queue } = this.queues[key] ?? emptyQueue();
    return structuredClone(queue);
  }

  private change(key: string, update: (queue: SavedQueue) => void): PromptQueueSnapshot {
    const queue = structuredClone(this.queues[key] ?? emptyQueue());
    update(queue);
    queue.revision++;
    const queues = { ...this.queues, [key]: queue };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, queues }), { mode: 0o600 });
      renameSync(temporary, this.file);
    }
    this.queues = queues;
    return this.snapshot(key);
  }

  add(key: string, id: string, text: string, autoRun: boolean): PromptQueueSnapshot {
    // Retain IDs after consumption/removal: a retried IPC cannot resurrect a message.
    if (this.queues[key]?.seen.includes(id)) return this.snapshot(key);
    return this.change(key, (q) => {
      if (q.items.length >= MAX_QUEUED_PROMPTS) throw new Error(`busy: 最多可排队 ${MAX_QUEUED_PROMPTS} 条消息`);
      if (!q.items.length) q.paused = !autoRun;
      q.items.push({ id, text, createdAt: Date.now(), status: "queued" });
      q.seen.push(id);
    });
  }

  edit(key: string, id: string, text: string): PromptQueueSnapshot {
    return this.change(key, (q) => {
      const item = q.items.find((i) => i.id === id);
      if (!item) throw new Error("not_found: 这条消息已离开队列");
      if (item.status === "sending" || item.status === "uncertain") throw new Error("busy: 消息已开始发送，请先核对执行结果");
      item.text = text;
      item.status = "queued";
      delete item.error;
    });
  }

  remove(key: string, id: string): PromptQueueSnapshot {
    return this.change(key, (q) => {
      if (q.items.find((i) => i.id === id)?.status === "sending") throw new Error("busy: 消息已开始发送");
      q.items = q.items.filter((i) => i.id !== id);
    });
  }

  pause(key: string): PromptQueueSnapshot {
    if (this.snapshot(key).paused || !this.snapshot(key).items.length) return this.snapshot(key);
    return this.change(key, (q) => { q.paused = true; });
  }

  resume(key: string): PromptQueueSnapshot {
    return this.change(key, (q) => {
      if (q.items.some((i) => i.status === "sending" || i.status === "uncertain")) {
        throw new Error("busy: 请先核对发送结果待确认的消息，并将它移出队列");
      }
      q.paused = false;
      for (const item of q.items) {
        item.status = "queued";
        delete item.error;
      }
    });
  }

  claim(key: string): QueuedPrompt | undefined {
    const q = this.snapshot(key);
    const first = q.items[0];
    if (q.paused || first?.status !== "queued") return undefined;
    const next = this.change(key, (queue) => { queue.items[0]!.status = "sending"; });
    return next.items[0];
  }

  complete(key: string, id: string): PromptQueueSnapshot {
    return this.change(key, (q) => { q.items = q.items.filter((i) => i.id !== id); });
  }

  fail(key: string, id: string, error: string, uncertain = false): PromptQueueSnapshot {
    return this.change(key, (q) => {
      const item = q.items.find((i) => i.id === id);
      if (item) { item.status = uncertain ? "uncertain" : "failed"; item.error = error; }
      q.paused = true;
    });
  }
}
