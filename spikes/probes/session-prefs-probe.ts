// session-prefs — 权限模式/模型选择的继承契约：
// 新对话继承全局最后一次（跨项目）；切换会话/项目恢复该目录最后一次的选择；
// 偏好持久化，重启后仍生效。无需真实 LLM（models.json 注入 fake provider）。

import { mkdtempSync, mkdirSync, writeFileSync, renameSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../apps/desktop/src/main/agent/permission-manager.js";
import { PiAdapter } from "../../apps/desktop/src/main/agent/pi-adapter.js";
import { SessionPrefsStore } from "../../apps/desktop/src/main/session-prefs.js";
import type { AgentHost } from "../../apps/desktop/src/main/agent/host.js";
import type { AgentEvent } from "@hello-agent/shared";
import { exitOn, Reporter } from "./harness.js";

const r = new Reporter();
process.env.PI_OFFLINE = "1"; // fake provider 不可达：禁用目录网络刷新
await r.run("session-prefs", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-prefs-"));
  // 应用层（canonicalize）与 SessionPrefsStore 均用 realpath 后的路径做 key，
  // 探针同样先 realpath，避免 macOS /var → /private/var 不一致。
  mkdirSync(join(root, "project-a"), { recursive: true });
  mkdirSync(join(root, "project-b"), { recursive: true });
  const dirA = realpathSync(join(root, "project-a"));
  const dirB = realpathSync(join(root, "project-b"));
  for (const d of [dirA, dirB]) mkdirSync(d, { recursive: true });

  const appData = join(root, "appdata");
  const agentDir = join(appData, "pi-agent");
  const paths = {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    auditFile: join(appData, "audit.jsonl"),
  };
  mkdirSync(paths.sessionsDir, { recursive: true });
  // fake provider：静态 apiKey → checkAuth 同步判定 configured，无需网络。
  writeFileSync(
    paths.modelsPath,
    JSON.stringify({
      providers: {
        fakeprov: {
          name: "Fake Provider",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "sk-fake-probe",
          api: "openai-completions",
          models: [
            { id: "fake-model", name: "Fake Model", contextWindow: 8192, maxTokens: 4096 },
            { id: "fake-model-2", name: "Fake Model 2", contextWindow: 8192, maxTokens: 4096 },
          ],
        },
      },
    }),
  );
  const prefsFile = join(appData, "session-prefs.json");
  const prefs = new SessionPrefsStore(prefsFile);

  let cwd = dirA;
  let trust: "untrusted" | "restricted" | "trusted" = "trusted";
  const host: AgentHost = {
    paths,
    getCwd: () => cwd,
    getTrust: () => trust,
    emit: (_e: AgentEvent) => {},
    getEnvKey: () => undefined,
    moveToTrash: async (p: string) => { renameSync(p, `${p}.trashed`); return true; },
  };
  const mkPermissions = () =>
    new PermissionManager({
      getTrust: () => trust,
      getCwd: () => cwd,
      getSessionId: () => adapter.sessionId,
      onApprovalRequested: () => {},
      onApprovalResolved: () => {},
      audit: () => {},
    });
  let permissions = mkPermissions();
  let adapter = new PiAdapter(host, permissions, { prefs });
  const model = () => {
    const m = (adapter as unknown as { session?: { model?: { provider: string; id: string } } }).session?.model;
    return m ? `${m.provider}/${m.id}` : null;
  };

  // ── A：初始状态 + 记录偏好 ──────────────────────────────────────────────
  await adapter.create(dirA);
  r.check("初始权限模式为 default", permissions.getMode() === "default");

  await adapter.selectModel("fakeprov/fake-model");
  r.check("selectModel 生效", model() === "fakeprov/fake-model", model() ?? "null");
  r.check("selectModel 记录全局 last", JSON.stringify(prefs.getLast()) === JSON.stringify({ permissionMode: "default", model: "fakeprov/fake-model" }), JSON.stringify(prefs.getLast()));
  r.check("selectModel 记录项目 A", !!prefs.getForProject(dirA));

  adapter.setPermissionMode("full");
  r.check("setPermissionMode(full) 生效并记录", permissions.getMode() === "full" && prefs.getLast()?.permissionMode === "full");

  // ── 新对话继承最后一次（权限 + 模型）────────────────────────────────────
  await adapter.newSession();
  r.check("新对话继承权限模式 full", permissions.getMode() === "full", permissions.getMode());
  r.check("新对话继承模型", model() === "fakeprov/fake-model", model() ?? "null");

  // 换模型后再新对话：继承的是最新的选择
  await adapter.selectModel("fakeprov/fake-model-2");
  await adapter.newSession();
  r.check("新对话继承最新模型", model() === "fakeprov/fake-model-2", model() ?? "null");

  // ── 切换会话：目录记忆覆盖会话文件里的旧模型 ────────────────────────────
  await seed(adapter);
  const fileA = adapter.sessionFilePath();
  r.check("会话文件已落盘", !!fileA);
  // 当前会话文件记录的模型是 fake-model-2；把目录记忆换成 fake-model，
  // 再切走切回：应恢复目录记忆的 fake-model，而不是文件里的 fake-model-2。
  await adapter.selectModel("fakeprov/fake-model");
  await adapter.newSession();
  await adapter.openSession(fileA!);
  r.check("切换会话恢复目录记忆的权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("切换会话恢复目录记忆的模型（覆盖文件旧值）", model() === "fakeprov/fake-model", model() ?? "null");

  // ── 切换项目：B 无记忆 → 沿用（继承最后一次对话）；有记忆 → 恢复记忆 ────
  cwd = dirB;
  await adapter.create(dirB);
  r.check("切到新项目沿用权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("切到新项目沿用模型", model() === "fakeprov/fake-model", model() ?? "null");
  r.check("切到新项目后记录了 B 的记忆", !!prefs.getForProject(dirB));

  // B 里改成 default + fake-model-2 → A 的记忆不受影响
  adapter.setPermissionMode("default");
  await adapter.selectModel("fakeprov/fake-model-2");
  cwd = dirA;
  await adapter.create(dirA);
  r.check("切回 A 恢复 A 的权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("切回 A 恢复 A 的模型", model() === "fakeprov/fake-model", model() ?? "null");

  // ── 重启恢复：重建 store/manager/adapter，从磁盘偏好恢复 ────────────────
  await adapter.dispose();
  const prefs2 = new SessionPrefsStore(prefsFile);
  permissions = mkPermissions();
  adapter = new PiAdapter(host, permissions, { prefs: prefs2 });
  await adapter.create(dirA);
  r.check("重启后恢复 A 的权限 full", permissions.getMode() === "full", permissions.getMode());
  r.check("重启后恢复 A 的模型", model() === "fakeprov/fake-model", model() ?? "null");

  // ── restricted 工作区：不恢复「完全访问」────────────────────────────────
  trust = "restricted";
  await adapter.create(dirA);
  r.check("restricted 工作区不恢复 full", permissions.getMode() === "default", permissions.getMode());
  trust = "trusted";

  // ── 持久化文件内容 sanity ────────────────────────────────────────────────
  const raw = JSON.parse(readFileSync(prefsFile, "utf8")) as { last?: unknown; projects?: unknown };
  r.check("prefs 文件含 last 与 projects", !!raw.last && typeof raw.projects === "object");

  await adapter.dispose();
  r.check("dispose 完成无挂起", true);
}

/** Append one user message without needing an LLM so pi flushes the JSONL. */
async function seed(adapter: PiAdapter): Promise<void> {
  const t = setTimeout(() => void adapter.abort().catch(() => {}), 3_000);
  try {
    await adapter.prompt("seed");
  } catch {
    /* expected without a real endpoint */
  } finally {
    clearTimeout(t);
    await new Promise((r) => setTimeout(r, 100));
  }
}
