// 复现探针：首轮对话结束后，listSessions 是否立即包含新会话？
//
// 需要 DEEPSEEK_API_KEY（无 key 时 SKIP）。验证：
// 1. prompt 完成后（agent.state=idle），session 文件已落盘且 list 可见
// 2. autoTitleSession 触发 session.renamed 事件并持久化标题

import { mkdirSync, mkdtempSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@hello-agent/shared";

const MODEL = "deepseek/deepseek-v4-flash";

if (!process.env.DEEPSEEK_API_KEY) {
  console.log("[probe] session-appear: DEEPSEEK_API_KEY 未设置，SKIP");
  process.exit(0);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-session-appear-"));
  const project = join(root, "project");
  const appData = join(root, "appdata");
  mkdirSync(project, { recursive: true });
  const paths = {
    agentDir: join(appData, "pi-agent"),
    sessionsDir: join(appData, "pi-agent", "sessions"),
    modelsPath: join(appData, "pi-agent", "models.json"),
    modelsStorePath: join(appData, "pi-agent", "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });

  const received: AgentEvent[] = [];
  // 模拟真实应用：openWorkspace 会 realpathSync，这里两种模式都测
  const CANONICALIZE = process.env.PROBE_CANONICALIZE !== "0";
  const projectForHost = CANONICALIZE ? realpathSync(project) : project;
  console.log("[probe] host.getCwd 返回:", projectForHost, CANONICALIZE ? "(realpath 后)" : "(原始路径)");
  let cwd = projectForHost;
  let trust: "untrusted" | "restricted" | "trusted" = "trusted";
  const host: AgentHost = {
    paths,
    getCwd: () => cwd,
    getTrust: () => trust,
    emit: (e) => received.push(e),
    getEnvKey: () => process.env.DEEPSEEK_API_KEY,
    moveToTrash: async (p: string) => { renameSync(p, p + ".trashed"); return true; },
  };
  const permissions = new PermissionManager({
    getTrust: () => trust,
    getCwd: () => cwd,
    getSessionId: () => adapter.sessionId,
    ttlMs: 60_000,
    onApprovalRequested: () => {},
    onApprovalResolved: () => {},
    audit: () => {},
  });
  const adapter = new PiAdapter(host, permissions);
  await adapter.create(project);
  await adapter.selectModel(MODEL);

  console.log("[probe] sessionId:", adapter.sessionId);

  await adapter.prompt("只回复两个字：好的");
  await adapter.flush();

  // 模拟 renderer 在 agent.state=idle 时的动作：立刻刷新会话列表
  const idleAt = received.findIndex((e) => e.type === "agent.state" && e.state === "idle");
  console.log("[probe] agent.state idle 事件序号:", idleAt >= 0 ? received[idleAt]!.sequence : "(未找到)");

  const listedRightAfterIdle = await adapter.listSessions();
  console.log("[probe] idle 后立刻 list:", listedRightAfterIdle.length, "个会话");

  // 等 autoTitleSession 的 LLM 调用返回（最多 25s）
  const renamedIdx = received.findIndex((e) => e.type === "session.renamed");
  const deadline = Date.now() + 25_000;
  let finalRenamed = renamedIdx;
  while (finalRenamed < 0 && Date.now() < deadline) {
    await new Promise((r2) => setTimeout(r2, 500));
    finalRenamed = received.findIndex((e) => e.type === "session.renamed");
  }
  if (finalRenamed >= 0) {
    const ev = received[finalRenamed] as { name?: string };
    console.log("[probe] session.renamed 收到，name =", ev.name);
  } else {
    console.log("[probe] ✗ 25s 内未收到 session.renamed");
  }

  const listedFinal = await adapter.listSessions();
  console.log("[probe] 最终 list:", listedFinal.length, "个会话");
  for (const s of listedFinal) {
    console.log("   -", s.file.split("/").pop(), "| name:", s.name ?? "(无)");
  }

  console.log("\n结论:",
    listedRightAfterIdle.length > 0
      ? "✓ idle 后 list 已能看到新会话（Main 层正常，问题在 Renderer）"
      : "✗ idle 后 list 为空（Main 层就有问题）");

  await adapter.dispose();
}

await main().catch((e) => {
  console.error("[probe] 失败:", e);
  process.exit(1);
});
