// Persisted window bounds — 记住窗口大小/位置/最大化状态（userData/window-state.json）。
// 恢复时对 bounds 做显示器可见性校验：显示器被拔掉或分辨率变化后落到屏幕外的
// 旧位置一律回退默认尺寸居中，保证窗口永远可用（fail-open to a usable window）。

import { screen, type BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 800;
/** 旧数据的下限防御：小于该尺寸视为脏数据，走默认值。 */
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

interface PersistedWindowState {
  version: 1;
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface RestoredWindowBounds {
  width: number;
  height: number;
  /** 仅在校验通过时提供；undefined = 让 Electron 居中。 */
  x?: number;
  y?: number;
}

export class WindowStateStore {
  private state: PersistedWindowState | undefined;

  constructor(private readonly filePath: string) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as PersistedWindowState;
      if (
        raw &&
        raw.version === 1 &&
        Number.isFinite(raw.width) &&
        Number.isFinite(raw.height) &&
        raw.width >= MIN_WIDTH &&
        raw.height >= MIN_HEIGHT
      ) {
        this.state = raw;
      }
    } catch {
      // 首次启动或文件损坏 → 默认尺寸（窗口状态可再生成，无需备份）。
    }
  }

  /** createWindow() 的初始 bounds。screen 仅在 app ready 后可用，勿提前调用。 */
  restore(): RestoredWindowBounds {
    const s = this.state;
    if (
      !s ||
      s.x === undefined ||
      s.y === undefined ||
      !isMostlyOnScreen({ x: s.x, y: s.y, width: s.width, height: s.height })
    ) {
      return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    }
    return { x: s.x, y: s.y, width: s.width, height: s.height };
  }

  get wasMaximized(): boolean {
    return this.state?.isMaximized ?? false;
  }

  /** close 时捕获当前状态；最大化/全屏时取还原态 bounds，下次以正常尺寸恢复。 */
  save(win: BrowserWindow): void {
    try {
      if (win.isDestroyed() || win.isMinimized()) return;
      const isMaximized = win.isMaximized();
      const bounds =
        isMaximized || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
      this.state = {
        version: 1,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized,
      };
      writeFileSync(this.filePath, JSON.stringify(this.state));
    } catch (e) {
      console.warn("[window-state] persist failed:", e);
    }
  }
}

/** 窗口面积仍有 ≥1/3 落在某台显示器可用区内才恢复位置。 */
function isMostlyOnScreen(b: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  let visible = 0;
  for (const display of screen.getAllDisplays()) {
    const wa = display.workArea;
    const w = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const h = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    if (w > 0 && h > 0) visible += w * h;
  }
  return visible >= (b.width * b.height) / 3;
}
