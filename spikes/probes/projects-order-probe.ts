// projects-order — 侧边栏项目顺序稳定性契约：
// 打开/切换项目不打乱已有顺序；仅新项目置顶、用户上移/下移、移除才会变化；
// lastOpened 单独记录最近打开的项目，供启动恢复，与显示顺序解耦。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectsStore } from "../../apps/desktop/src/main/projects-store.js";
import { exitOn, Reporter } from "./harness.js";

const r = new Reporter();
await r.run("projects-order", () => main());
exitOn(r);

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spike-porder-"));
  const file = join(root, "projects.json");
  const sessionsDir = join(root, "sessions");
  const store = new ProjectsStore(file, sessionsDir);

  // 依次打开三个项目：新项目置顶。
  store.add("/tmp/p-a");
  store.add("/tmp/p-b");
  store.add("/tmp/p-c");
  r.check(
    "新项目依次置顶",
    JSON.stringify(store.list()) === JSON.stringify(["/tmp/p-c", "/tmp/p-b", "/tmp/p-a"]),
    JSON.stringify(store.list()),
  );
  r.check("lastOpened 为最近打开的 C", store.lastOpened() === "/tmp/p-c", store.lastOpened() ?? "null");

  // 重新打开已有项目 A（如跨项目切会话触发）：顺序不变，仅 lastOpened 更新。
  store.add("/tmp/p-a");
  r.check(
    "重开已有项目不改变顺序",
    JSON.stringify(store.list()) === JSON.stringify(["/tmp/p-c", "/tmp/p-b", "/tmp/p-a"]),
    JSON.stringify(store.list()),
  );
  r.check("lastOpened 更新为 A", store.lastOpened() === "/tmp/p-a");

  // 用户上移/下移重排：顺序持久化。
  store.reorder(["/tmp/p-a", "/tmp/p-b", "/tmp/p-c"]);
  r.check("reorder 生效", JSON.stringify(store.list()) === JSON.stringify(["/tmp/p-a", "/tmp/p-b", "/tmp/p-c"]));

  // 重开项目不冲掉用户排好的顺序。
  store.add("/tmp/p-b");
  r.check(
    "重开后仍保持用户排序",
    JSON.stringify(store.list()) === JSON.stringify(["/tmp/p-a", "/tmp/p-b", "/tmp/p-c"]),
    JSON.stringify(store.list()),
  );

  // 移除 lastOpened 指向的项目：记录清空，回退列表第一个。
  store.remove("/tmp/p-a");
  r.check(
    "remove 更新列表",
    JSON.stringify(store.list()) === JSON.stringify(["/tmp/p-b", "/tmp/p-c"]),
    JSON.stringify(store.list()),
  );
  r.check("lastOpened 清空后回退第一个", store.lastOpened() === "/tmp/p-b", store.lastOpened() ?? "null");

  // 持久化：重建 store 后顺序与 lastOpened 保留。
  store.add("/tmp/p-c"); // lastOpened = c
  const store2 = new ProjectsStore(file, sessionsDir);
  r.check(
    "重启后顺序保留",
    JSON.stringify(store2.list()) === JSON.stringify(["/tmp/p-b", "/tmp/p-c"]),
    JSON.stringify(store2.list()),
  );
  r.check("重启后 lastOpened 保留", store2.lastOpened() === "/tmp/p-c", store2.lastOpened() ?? "null");

  // 旧版文件（只有 projects 字段）向后兼容。
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify({ projects: ["/tmp/x", "/tmp/y"] }));
  const store3 = new ProjectsStore(file, sessionsDir);
  r.check("旧格式文件兼容", JSON.stringify(store3.list()) === JSON.stringify(["/tmp/x", "/tmp/y"]));
  r.check("旧格式 lastOpened 回退第一个", store3.lastOpened() === "/tmp/x", store3.lastOpened() ?? "null");
}
