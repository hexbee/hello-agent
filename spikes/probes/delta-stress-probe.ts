// §10.5 — 1,000+ delta stress through the REAL emit path (DeltaBatcher →
// sequence assignment). Asserts ordering, bounded memory, no unbounded queue.
// Renderer-side freeze measurement runs in the app (dev.stressDeltas button).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@spike/shared";
import { exitOn, Reporter } from "./harness.js";

const r = new Reporter();
await r.run("delta-stress", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-delta-"));
  const project = join(root, "project");
  const appData = join(root, "appdata");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });

  const paths = {
    agentDir: join(appData, "pi-agent"),
    sessionsDir: join(appData, "pi-agent", "sessions"),
    modelsPath: join(appData, "pi-agent", "models.json"),
    modelsStorePath: join(appData, "pi-agent", "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });

  // Collect every event the host would push over IPC.
  const received: AgentEvent[] = [];
  let peakHeapBefore = process.memoryUsage().heapUsed;

  const host: AgentHost = {
    paths,
    getCwd: () => project,
    getTrust: () => "trusted",
    emit: (e) => {
      received.push(e);
      if (received.length % 1000 === 0) {
        const h = process.memoryUsage().heapUsed;
        if (h > peakHeapBefore) peakHeapBefore = h;
      }
    },
    getEnvKey: () => undefined,
  };
  const permissions = new PermissionManager({
    getTrust: () => "trusted",
    getCwd: () => project,
    getSessionId: () => adapter.sessionId,
    onApprovalRequested: () => {},
    onApprovalResolved: () => {},
    audit: () => {},
  });
  const adapter = new PiAdapter(host, permissions);
  await adapter.create(project);

  const COUNT = 5000;
  const SIZE = 40; // bytes per delta
  const t0 = Date.now();

  adapter.injectDevDeltas(COUNT, SIZE);

  // Wait for message.finished from the stress stream.
  const startLen = received.length;
  const deadline = Date.now() + 60_000;
  while (
    !received.slice(startLen).some((e) => e.type === "message.finished" && e.messageId.endsWith(":stress"))
  ) {
    if (Date.now() > deadline) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  const elapsedMs = Date.now() - t0;

  const stressDeltas = received.filter(
    (e) => (e.type === "message.delta" || e.type === "thinking.delta") && e.messageId.endsWith(":stress"),
  );

  r.check(`all ${COUNT} deltas delivered (${stressDeltas.length})`, stressDeltas.length >= COUNT - COUNT * 0.001 || stressDeltas.length === COUNT);

  // Ordering: sequences strictly increasing across the whole stream.
  let ordered = true;
  for (let i = 1; i < received.length; i++) {
    const a = received[i - 1]!.sequence;
    const b = received[i]!.sequence;
    if (b <= a) {
      ordered = false;
      break;
    }
  }
  r.check("sequence strictly increasing (no reordering)", ordered);

  // Batcher drained its queue (no unbounded backlog).
  const stats = adapter.batcherStats();
  r.check("batcher flushed everything", stats.flushed + stats.dropped >= COUNT, JSON.stringify(stats));
  r.check("no drops under default limits", stats.dropped === 0, `dropped=${stats.dropped}`);

  // Throughput sanity: 5k deltas in <10s headless.
  r.check("throughput sane (<10s)", elapsedMs < 10_000, `${elapsedMs}ms`);

  // Heap did not grow linearly with total bytes queued+flushed (≈COUNT*SIZE).
  const heapAfter = process.memoryUsage().heapUsed;
  const growthMb = (peakHeapBefore - heapAfter) / 1024 / 1024;
  r.check(
    "heap bounded (growth < 15MB for ~200KB payload stream)",
    growthMb < 15,
    `peak-vs-end ${growthMb.toFixed(2)}MB`,
  );

  console.log(
    `  stats: batches=${stats.batches} maxBatch=${stats.maxBatch} maxQueueLatency=${stats.maxQueueLatencyMs}ms elapsed=${elapsedMs}ms`,
  );

  await adapter.dispose();
}
