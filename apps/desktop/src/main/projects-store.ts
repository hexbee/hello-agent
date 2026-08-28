// Persisted list of opened projects + read-only session scan per project.
// The renderer never supplies arbitrary paths: it selects among projects that
// Main itself recorded (§4.1 spirit). Session files live under the app-private
// sessionsDir; listing only reads metadata, no workspace files.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface ProjectSessionInfo {
  file: string;
  name?: string;
  modified?: number;
}

export interface ProjectSessions {
  cwd: string;
  name: string;
  sessions: ProjectSessionInfo[];
}

export class ProjectsStore {
  private cwds: string[] = [];
  /** 最近打开的项目（仅供启动恢复；不影响侧边栏显示顺序）。 */
  private lastOpenedCwd: string | null = null;

  constructor(
    private readonly file: string,
    private readonly sessionsDir: string,
  ) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        projects?: unknown;
        lastOpened?: unknown;
      };
      this.cwds = Array.isArray(raw.projects)
        ? raw.projects.filter((p): p is string => typeof p === "string")
        : [];
      this.lastOpenedCwd =
        typeof raw.lastOpened === "string" && this.cwds.includes(raw.lastOpened)
          ? raw.lastOpened
          : null;
    } catch {
      this.cwds = [];
      this.lastOpenedCwd = null;
    }
  }

  private save(): void {
    writeFileSync(
      this.file,
      JSON.stringify({ projects: this.cwds, lastOpened: this.lastOpenedCwd }, null, 2),
    );
  }

  list(): string[] {
    return [...this.cwds];
  }

  /** 最近打开的项目（启动恢复用）；无记录时回退列表第一个。 */
  lastOpened(): string | null {
    return this.lastOpenedCwd ?? this.cwds[0] ?? null;
  }

  /**
   * 记录一次项目打开：仅新项目插入列表最前（侧边栏置顶可见）；
   * 已有项目保持原位——切换项目/跨项目切会话不应打乱用户排好的顺序。
   * 同时更新 lastOpened，供下次启动恢复到最近工作的项目。
   */
  add(cwd: string): void {
    if (!this.cwds.includes(cwd)) this.cwds = [cwd, ...this.cwds];
    this.lastOpenedCwd = cwd;
    this.save();
  }

  /**
   * Forget a saved project. Session files stay on disk; re-opening the folder
   * via a dialog re-records it (`add`), so it can be re-added any time.
   */
  remove(cwd: string): void {
    this.cwds = this.cwds.filter((p) => p !== cwd);
    if (this.lastOpenedCwd === cwd) this.lastOpenedCwd = null;
    this.save();
  }

  /**
   * Persist a new order for the saved projects. `order` must be a permutation
   * of the current list (same set, same length) — the renderer only reorders
   * main-known paths, never supplies arbitrary ones (§4.1).
   */
  reorder(order: string[]): void {
    if (order.length !== this.cwds.length) throw new Error("invalid project order");
    const current = new Set(this.cwds);
    const seen = new Set<string>();
    for (const cwd of order) {
      if (!current.has(cwd) || seen.has(cwd)) throw new Error("invalid project order");
      seen.add(cwd);
    }
    this.cwds = [...order];
    this.save();
  }

  /**
   * Read-only scan of every saved project's session metadata. No runtime is
   * required — SessionManager.list filters app-owned session files by the
   * cwd recorded in each session header.
   */
  async listSessions(): Promise<ProjectSessions[]> {
    const result: ProjectSessions[] = [];
    for (const cwd of this.cwds) {
      let sessions: ProjectSessionInfo[] = [];
      try {
        const infos = await SessionManager.list(cwd, this.sessionsDir);
        sessions = infos.map((i) => ({
          file: i.path ?? "",
          name: i.name,
          modified: i.modified.getTime(),
        }));
      } catch {
        // project dir may have been deleted; surface it as empty
      }
      result.push({ cwd, name: basename(cwd), sessions });
    }
    return result;
  }
}
