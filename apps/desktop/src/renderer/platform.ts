// 宿主平台适配常量。macOS 无边框窗口（hiddenInset）有红绿灯嵌顶等特殊布局，
// 渲染层据此调整顶栏/侧边栏的留白。
export const isMac = window.helloAgent?.platform === "darwin";
