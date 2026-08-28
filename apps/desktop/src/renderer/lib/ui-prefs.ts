// UI 偏好持久化（localStorage）— 侧边栏宽度/折叠、项目树展开状态等
// 非敏感界面偏好。与 store.ts 的 thinking-durations 同一模式：
// 只存非敏感 UI 偏好；读取失败或缺 key 回退默认值，写入失败静默。

const NS = "hello-agent:ui:";

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    /* storage 不可用（隐私模式等）时静默 */
  }
}
