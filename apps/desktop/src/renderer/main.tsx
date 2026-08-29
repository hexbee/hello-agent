import * as Sentry from "@sentry/electron/renderer";

// 渲染进程错误/性能 —— 事件经 preload IPC 桥转发到主进程统一发送（无需 dsn）。
Sentry.init({
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: 1.0,
  enableLogs: true,
});

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import { store } from "./store";
import "./styles.css";

void store.init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
