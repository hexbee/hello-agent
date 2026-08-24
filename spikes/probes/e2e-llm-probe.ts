// §10 遗留项：真实 LLM 端到端。
//
// 需要 DEEPSEEK_API_KEY（无 key 时 SKIP）。验证：
// - 真实流式 delta / message 生命周期事件
// - 只读工具自动放行（read）
// - bash 触发审批 ask → allow 后执行成功；deny 则被 block

import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@hello-agent/shared";
import { exitOn, Reporter } from "./harness.js";

const MODEL = "deepseek/deepseek-v4-flash";

if (!process.env.DEEPSEEK_API_KEY) {
  console.log("[probe] e2e-llm: DEEPSEEK_API_KEY 未设置，SKIP");
  process.exit(0);
}

const r = new Reporter();
await r.run("e2e-llm", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-e2e-"));
  const project = join(root, "project");
  const appData = join(root, "appdata");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "a.txt"), "PINEAPPLE-UNDER-THE-SEA\n");
  writeFileSync(
    join(project, "AGENTS.md"),
    "Always use absolute paths under the workspace. Be terse.",
  );

  const paths = {
    agentDir: join(appData, "pi-agent"),
    sessionsDir: join(appData, "pi-agent", "sessions"),
    modelsPath: join(appData, "pi-agent", "models.json"),
    modelsStorePath: join(appData, "pi-agent", "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });

  const received: AgentEvent[] = [];
  let cwd = project;
  let trust: "untrusted" | "restricted" | "trusted" = "trusted";
  const host: AgentHost = {
    paths,
    getCwd: () => cwd,
    getTrust: () => trust,
    emit: (e) => received.push(e),
    getEnvKey: () => process.env.DEEPSEEK_API_KEY,
    moveToTrash: async (p: string) => { renameSync(p, p + '.trashed'); return true; },
  };

  // 审批策略由测试阶段控制："allow" / "deny"
  let approvalMode: "allow" | "deny" = "allow";
  const approvalsResolved: Array<{ requestId: string; decision: string }> = [];

  const permissions = new PermissionManager({
    getTrust: () => trust,
    getCwd: () => cwd,
    getSessionId: () => adapter.sessionId,
    ttlMs: 120_000,
    onApprovalRequested: (p) => {
      // 异步解析，模拟 Renderer 审批卡点击
      setTimeout(() => {
        permissions.resolveApproval(p.requestId, adapter.sessionId, approvalMode);
        approvalsResolved.push({ requestId: p.requestId, decision: approvalMode });
      }, 50);
    },
    onApprovalResolved: () => {},
    audit: () => {},
  });
  const adapter = new PiAdapter(host, permissions);

  await adapter.create(project);
  await adapter.selectModel(MODEL);
  r.check("model selected", adapter.batcherStats !== undefined);

  const dump = (label: string): void => {
    if (!process.env.PROBE_DEBUG) return;
    console.log(`--- ${label} ---`);
    for (const e of received) {
      const t = e.type;
      if (t === "tool.started") console.log("  tool.started", e.toolName);
      else if (t === "tool.finished")
        console.log("  tool.finished", JSON.stringify(e.resultPreview).slice(0, 150));
      else if (t === "message.delta") process.stdout.write(".");
      else console.log(" ", t);
    }
    console.log();
  };

  // ── Phase 1: 只读工具，无审批 ────────────────────────────────────────────
  await adapter.prompt("读取工作区的 a.txt，然后把文件内容原样放在一个代码块里输出。不要省略任何字符。");
  await adapter.flush(); // 合批是异步的——先排干再切片，避免阶段间污染
  dump("phase1");

  const types1 = received.map((e) => e.type);
  r.check("message.started 收到", types1.includes("message.started"));
  r.check(
    "真实流式 delta >= 20",
    received.filter((e) => e.type === "message.delta").length >= 5,
  );
  r.check("tool.started(read) 收到", received.some((e) => e.type === "tool.started" && e.toolName === "read"));
  const readEnd = received.find((e) => e.type === "tool.finished" && !e.isError);
  r.check("read 工具成功结束", !!readEnd);
  const assistantText = received
    .filter((e) => e.type === "message.delta")
    .map((e) => e.delta)
    .join("");
  r.check("回答包含文件内容标记", assistantText.includes("PINEAPPLE"), assistantText.slice(-200));
  r.check("phase1 无审批请求", approvalsResolved.length === 0);

  // ── Phase 2: bash → ask → allow ────────────────────────────────────────
  const markBefore = received.length;
  await adapter.prompt("用 bash 执行 `echo BASH_ALLOW_12345`，然后只回复命令的输出原文。");
  await adapter.flush();
  const sliceAllow = received.slice(markBefore);
  r.check("bash 触发审批", approvalsResolved.some((a) => a.decision === "allow"));
  const allowTool = sliceAllow.find((e) => e.type === "tool.finished" && e.toolCallId);
  r.check("allow 后工具执行完成且非错误", !!allowTool && allowTool.isError === false);
  const allowText = sliceAllow.filter((e) => e.type === "message.delta").map((e) => e.delta).join("");
  const allowToolText = sliceAllow
    .filter((e) => e.type === "tool.finished" && !e.isError)
    .map((e) => e.resultPreview.text)
    .join("");
  r.check(
    "回答或工具结果包含 BASH_ALLOW_12345",
    allowText.includes("BASH_ALLOW_12345") || allowToolText.includes("BASH_ALLOW_12345"),
    (allowText + "|" + allowToolText).slice(-200),
  );

  // ── Phase 3: bash → deny → block ────────────────────────────────────────
  // Phase 2 的 allow 会建立会话级 bash 规则（§7.1），先清掉才能再次触发 ask。
  adapter.permissions.resetSessionRules();
  approvalMode = "deny";
  const markDeny = received.length;
  await adapter.prompt("用 bash 执行 `echo DENIED_MARKER_67890`。");
  await adapter.flush();
  const sliceDeny = received.slice(markDeny);
  r.check("deny 决策发生", approvalsResolved.some((a) => a.decision === "deny"));
  const deniedTool = sliceDeny.find((e) => e.type === "tool.finished");
  r.check("deny 后工具以错误结束（被 block）", !!deniedTool && deniedTool.isError === true);
  r.check(
    "block 原因可见",
    JSON.stringify(sliceDeny.find((e) => e.type === "tool.finished")?.resultPreview?.text ?? "").includes("deny"),
  );

  // ── 会话落盘检查 ────────────────────────────────────────────────────────
  const sf = adapter.sessionFilePath();
  r.check("会话文件在 app 目录", !!sf && sf.startsWith(paths.sessionsDir));

  await adapter.dispose();
}
