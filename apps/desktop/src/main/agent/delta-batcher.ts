// Bounded coalescing queue for delta events — §6.3.
// Deltas enqueue with preserved order; flush happens on a short window or when
// the byte cap is hit. Sequence numbers are assigned by the emitter at flush
// time, so ordering is monotonic and gaps only occur where deltas were dropped
// wholesale (never reordered).

import type { AgentEvent } from "@hello-agent/shared";

export interface DeltaBatcherOptions {
  /** Max ms between flushes while deltas keep arriving. */
  windowMs?: number;
  /** Max queued bytes before an immediate flush. */
  maxBytes?: number;
  /** Max queued events — safety valve; beyond this, oldest deltas are dropped. */
  maxEvents?: number;
}

type Delta = Extract<AgentEvent, { type: "message.delta" | "thinking.delta" }>;

function isDelta(e: AgentEvent): e is Delta {
  return e.type === "message.delta" || e.type === "thinking.delta";
}

export class DeltaBatcher {
  private queue: Delta[] = [];
  private bytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  stats = { flushed: 0, batches: 0, dropped: 0, maxBatch: 0, maxQueueLatencyMs: 0 };

  constructor(
    private send: (events: Delta[]) => void,
    private opts: DeltaBatcherOptions = {},
  ) {}

  push(event: AgentEvent): void {
    if (!isDelta(event)) return;
    const maxEvents = this.opts.maxEvents ?? 8_192;
    const maxBytes = this.opts.maxBytes ?? 256 * 1024;
    const windowMs = this.opts.windowMs ?? 16;

    if (this.queue.length >= maxEvents) {
      // Drop oldest to bound memory (§6.3 "无界积压" prohibition); snapshot heals.
      this.queue.shift();
      this.stats.dropped++;
    }
    this.queue.push(event);
    this.bytes += event.delta.length;

    if (this.bytes >= maxBytes) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, windowMs);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      const batch = this.queue;
      this.queue = [];
      this.bytes = 0;
      this.stats.batches++;
      this.stats.maxBatch = Math.max(this.stats.maxBatch, batch.length);
      const now = Date.now();
      for (const d of batch) {
        this.stats.maxQueueLatencyMs = Math.max(
          this.stats.maxQueueLatencyMs,
          now - d.timestamp,
        );
      }
      this.stats.flushed += batch.length;
      this.send(batch);
      // Yield so long streams can't starve the main process event loop.
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      this.flushing = false;
      // Anything that arrived during flush gets sent on the next tick.
      if (this.queue.length > 0) {
        setTimeout(() => void this.flush(), 0);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}
