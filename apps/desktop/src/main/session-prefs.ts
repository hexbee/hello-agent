// Persisted session preferences — 全局最后一次对话 + 按项目目录记忆的
// 权限模式与模型选择。新对话继承全局最后一次（无论哪个项目）；
// 切换会话/项目时恢复该目录最后一次的选择。仅存非敏感偏好
// （模式枚举 + "provider/modelId" 引用），不含任何凭据。

import type { ThinkingLevel } from "@hello-agent/shared";
import { readFileSync, writeFileSync } from "node:fs";

export type PrefPermissionMode = "default" | "full";

export interface SessionPrefs {
  permissionMode: PrefPermissionMode;
  /** Canonical "provider/modelId" 引用；null = 只记住了权限模式。 */
  model: string | null;
  thinkingLevel?: ThinkingLevel;
}

interface PrefsFile {
  last: SessionPrefs | null;
  projects: Record<string, SessionPrefs>;
}

export class SessionPrefsStore {
  private data: PrefsFile = { last: null, projects: {} };

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PrefsFile>;
      this.data = {
        last: raw.last ?? null,
        projects:
          raw.projects && typeof raw.projects === "object" ? raw.projects : {},
      };
    } catch {
      this.data = { last: null, projects: {} };
    }
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn("[session-prefs] persist failed:", e);
    }
  }

  /** 全局最后一次对话的偏好（跨项目，供「新对话」继承）。 */
  getLast(): SessionPrefs | null {
    return this.data.last;
  }

  /** 某个项目目录最后一次对话的偏好（供切换会话/项目时恢复）。 */
  getForProject(cwd: string): SessionPrefs | null {
    return this.data.projects[cwd] ?? null;
  }

  /**
   * 记录一次偏好使用：同时更新全局 last 与该项目目录的记忆。
   * 语义上「当前会话的状态」始终等于「最后一次对话」，因此调用方
   * 在权限/模型变化以及每次会话落定（新建/打开/切换）后记录即可。
   */
  record(cwd: string, prefs: SessionPrefs): void {
    if (prefs.permissionMode !== "default" && prefs.permissionMode !== "full") return;
    this.data.last = prefs;
    this.data.projects[cwd] = prefs;
    this.save();
  }
}
