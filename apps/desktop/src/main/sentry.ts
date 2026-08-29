// Sentry 主进程初始化 — 本地调试专用（Spotlight 模式，§技能 sentry-cli）。
//
// 不设 DSN：事件只会发送到本地 Spotlight 服务器，不会离开本机。
// `sentry local run -- pnpm dev` 会注入 SENTRY_SPOTLIGHT=http://localhost:8969/stream，
// 普通 `pnpm dev` 下该环境变量为空 → spotlight 关闭，SDK 静默不发送。
//
// 未来要上报 Sentry 组织时：在下方填入 dsn，并将 spotlight 置为 false。

import * as Sentry from "@sentry/electron/main";

const spotlightUrl = process.env.SENTRY_SPOTLIGHT;

Sentry.init({
  spotlight: spotlightUrl ?? false, // 文档意图；electron main init 不消费此选项（见下）
  tracesSampleRate: 1.0,
  // 函数形式（core v10 支持）：拿到完整默认列表再做增删。
  integrations: (defaults) => [
    // SentryMinidump 依赖真实 DSN：无 DSN 时 setup() 直接 throw 且无人捕获，
    // 会炸掉主进程加载（"Attempted to enable Electron native crash reporter...")。
    // 本地 Spotlight 模式无 DSN，故移除 —— 原生 minidump 崩溃捕获随之关闭，
    // JS 异常仍由 onUncaughtException/onUnhandledRejection/IPC 桥捕获。
    ...defaults.filter((i) => i.name !== "SentryMinidump"),
    Sentry.startupTracingIntegration(),
    // @sentry/electron/main 的 init() 自成一体，不像 node-core 那样自动消费
    // spotlight 选项 —— 必须显式挂 spotlightIntegration。它挂在 client 的
    // beforeEnvelope 上：错误/事务/日志（含 renderer 经 IPC 转发的事件）全部
    // 转发到本地 Spotlight，无 DSN 也不会发往 sentry.io。
    ...(spotlightUrl ? [Sentry.spotlightIntegration({ sidecarUrl: spotlightUrl })] : []),
  ],
  enableLogs: true,
});

// 自检钩子（Verify your setup，docs.sentry.io/platforms/javascript/guides/electron）：
//   SENTRY_TEST_ERROR=1 sentry local run -- pnpm dev
// 启动 3 秒后捕获一个测试错误，用于验证事件确实到达 Spotlight。
if (process.env.SENTRY_TEST_ERROR) {
  setTimeout(() => {
    Sentry.captureException(new Error("[sentry-test] main process test error"));
  }, 3000);
}
