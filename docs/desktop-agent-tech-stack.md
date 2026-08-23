# 桌面 Agent 技术选型文档

> 状态：选型已定，待实施
> 日期：2026-02
> 目标：基于 pi SDK + Electron 构建本地 coding agent 桌面客户端

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────┐
│ Electron 渲染进程 (React + Tailwind)             │
│   beUI 组件 + markstream-react 流式渲染           │
│              ▲ │ IPC (contextBridge)             │
├──────────────┼─▼─────────────────────────────────┤
│ Electron 主进程 (Node)                           │
│   AgentService: 封装 pi SDK                      │
└─────────────────────────────────────────────────┘
```

职责划分：

- **主进程**：持有 pi `AgentSession`，执行 agent 循环与工具调用，通过 IPC 向渲染进程转发事件流、接收用户指令。
- **渲染进程**：纯展示层。聊天流、工具调用面板、会话管理、模型切换，全部通过 IPC 与主进程通信。

## 2. 分层选型

| 层 | 选型 | 理由 |
|---|---|---|
| Agent 内核 | `@earendil-works/pi-coding-agent` SDK（主进程直嵌） | 官方支持桌面嵌入场景；事件流完整；会话树 / fork / compaction / 多 provider 开箱即用 |
| Agent 内核备选 | RPC 子进程模式（`pi --mode rpc`） | 如需崩溃隔离或主进程不想引入 pi 依赖时切换 |
| 桌面壳 | Electron | 已定 |
| UI 框架 | React 18+ / Tailwind v4 | beUI 与 markstream-react 的共同 peer 要求 |
| 组件库 | beUI（shadcn registry 拉取源码） | agent UI 组件工程化程度最高：TypeScript props 完整、支持 reduced-motion；`prompt-input` API 与 pi SDK 天然对齐 |
| Markdown 流渲染 | markstream-react ≥2.0 | 内置 smooth streaming、`htmlPolicy="safe"` 安全默认、Mermaid/KaTeX 可选 peer |
| 图标 | lucide-react（随 beUI 组件引入） | beUI 源码全部使用 lucide，保留即全项目单一图标族；符合 design-taste 豁免条款（"project already depends on it"）。Phosphor 为可选后续迁移项（见第 6 节） |
| 动画 | Motion (`motion/react`) | beUI 已依赖，不额外引入 GSAP |

### 2.1 为什么是 pi SDK 而不是 RPC

- 同进程类型安全，直接访问 session 状态（`session.messages`、`session.agent.state`）
- 官方文档明确将 "Build a custom UI (web, desktop, mobile)" 列为 SDK 用例
- RPC 仅在需要进程隔离时作为后备方案，注意协议要求严格按 `\n` 分帧（不能用 `readline`）

### 2.2 为什么是 beUI 而不是 Beautiful UI

- beUI 是真正的组件库：shadcn registry 安装、完整 TS 类型、`useReducedMotion` 支持
- `prompt-input` 的 props（`models`/`onModelChange`/`loading`/`onStop`/`onSubmit`）几乎一一对应 pi SDK 能力
- 自带 `message-scroller`（跟随流式 live edge、用户上滚释放控制），自研成本高
- Beautiful UI（beautifului.dev）降级为长尾模式的视觉参考（表格类、Flowchart、Insight Cards 等 beUI 未覆盖的模式）

## 3. 核心数据流映射

| pi SDK 事件/API | IPC Channel（建议） | UI 承接 |
|---|---|---|
| `text_delta` | `agent:text-delta` | markstream-react：流式中 `smoothStreaming="auto"` + `fade={false}`；历史回放切 `smoothStreaming={false}` + `fade={true}` |
| `thinking_delta` | `agent:thinking-delta` | beUI `agent-activity` 推理链折叠面板 |
| `tool_execution_start/end` | `agent:tool-start/end` | beUI `tool-result` chips |
| edit 工具 `details.patch` | 随 tool-end 载荷 | beUI `file-diff` 渲染文件变更 |
| 权限确认（扩展拦截 `tool_call`） | `agent:approval-request` / `agent:approval-response` | beUI `approval-card` / `tool-approval` |
| `isStreaming` / `abort()` | `agent:state` / `agent:abort` | beUI `prompt-input` 的 `loading` / `onStop` |
| `ModelRuntime.getAvailable()` | `agent:models` | beUI `prompt-input` 的 `models` / `onModelChange` |
| `SessionManager.list/open` | `session:list` / `session:open` | 会话侧边栏 |

### 3.1 主进程骨架（示意）

```typescript
// electron/main/agentService.ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

session.subscribe((event) => {
  if (event.type === "message_update") {
    const e = event.assistantMessageEvent;
    if (e.type === "text_delta") mainWindow.webContents.send("agent:text-delta", e.delta);
    if (e.type === "thinking_delta") mainWindow.webContents.send("agent:thinking-delta", e.delta);
  }
  if (event.type === "tool_execution_start") {
    mainWindow.webContents.send("agent:tool-start", { name: event.toolName, callId: event.toolCallId });
  }
  if (event.type === "tool_execution_end") {
    mainWindow.webContents.send("agent:tool-end", { callId: event.toolCallId, isError: event.isError });
  }
  if (event.type === "agent_end") mainWindow.webContents.send("agent:done");
});

ipcMain.handle("agent:prompt", (_e, text: string) => session.prompt(text));
ipcMain.handle("agent:abort", () => session.abort());
```

### 3.2 渲染进程骨架（示意）

```tsx
function AssistantMessage({ isStreaming }: { isStreaming: boolean }) {
  const [content, setContent] = useState("");

  useEffect(() => {
    const onDelta = (_e: unknown, delta: string) => setContent((c) => c + delta);
    window.agent.onTextDelta(onDelta);
    return () => window.agent.offTextDelta(onDelta);
  }, []);

  // 流式 vs 历史动态切换
  return (
    <Markstream
      content={content}
      smoothStreaming={isStreaming ? "auto" : false}
      fade={!isStreaming}
      typewriter={isStreaming}
    />
  );
}
```

注意事项：

- 单条 assistant message 做成独立 memo 组件，delta 只触发自身重渲染
- `await session.prompt()` 会等整轮结束，流式 UI 完全靠 subscribe 事件驱动，不要在 IPC handler 里等它
- 工具调用从文本流中拆出单独渲染，markdown 只渲染纯文本部分

## 4. 安装清单

### 4.1 主进程

```bash
npm i @earendil-works/pi-coding-agent
```

打包时确保 pi 位于 main 的 dependencies（electron-builder 的 `files` 配置），不要被 tree-shake。

### 4.2 渲染进程（最小 peer 集）

```bash
npm i react react-dom tailwindcss motion
npm i markstream-react stream-diffs mermaid katex

# beUI 组件（shadcn registry）
npx shadcn add https://beui.dev/r/prompt-input \
                https://beui.dev/r/agent-activity \
                https://beui.dev/r/tool-result \
                https://beui.dev/r/file-diff \
                https://beui.dev/r/approval-card \
                https://beui.dev/r/message-scroller
```

跳过的可选 peer（最小安装原则）：`@terrastruct/d2`、`@antv/infographic`。

### 4.3 CSS 引入顺序（渲染进程入口）

```tsx
import './reset.css'                          // reset 在前
import 'markstream-react/index.css'           // Tailwind 项目用 layer(components)
import 'katex/dist/katex.min.css'             // 启用公式时必须显式引入
```

Tailwind 项目中 markstream 样式写法：

```css
@import 'markstream-react/index.css' layer(components);
```

## 5. 功能开关

| 功能 | 支持 | 说明 |
|---|---|---|
| Mermaid 图表 | ✅ 装 `mermaid >= 11` 即自动启用 | ` ```mermaid ` 围栏渲染为图表 |
| KaTeX 公式 | ✅ 装 `katex >= 0.16.22` + 引入其 CSS | 行内/块级 LaTeX |
| 增强代码块 / Diff | ✅ `stream-diffs` | 不装则降级普通 `<pre><code>` |
| D2 / 信息图 | ⏸ 暂不装 | agent 输出极少出现，需要再加 |

## 6. 关键约束与备忘

1. **安全默认不放宽**：markstream 保持 `htmlPolicy="safe"` 和 Mermaid strict mode（agent 输出不可信）；pi 无内置权限弹窗，确认流程用扩展的 `tool_call` 事件自建，对接 approval-card。
2. **pi 只跑在主进程**：依赖 Node API（fs、child_process），不能进渲染进程。
3. **项目信任机制**：打开新项目目录时用 `defaultProjectTrust` 控制，UI 复刻确认流程。
4. **MVP 范围**：6 个 beUI 组件起步（见安装清单）；Beautiful UI 仅作参考不引入代码。
5. **设计纪律**：
   - 单一 accent 色、统一圆角系统、暗色优先双模式（WCAG AA）
   - 反 AI 味清单执行（无装饰性状态点滥用、无 em-dash、无假精确数字、无 div 拼假截图）
   - 三态完整：loading（骨架屏）/ empty / error
6. **性能**：animate 只用 transform/opacity；`prefers-reduced-motion` 全链路尊重（beUI 内置）；LCP < 2.5s。
7. **图标策略**：MVP 阶段保留 lucide-react（随 beUI 引入），全项目单一图标族，不混用；全局 `strokeWidth` 统一为 2。若产品成型后需要品牌差异化，再做一次性 Phosphor 迁移（届时组件数量固定，用 codemod 批量改 import，Phosphor regular weight 对齐 lucide strokeWidth 2）

## 7. 参考资源

| 资源 | 地址 |
|---|---|
| pi SDK 文档 | 本地 `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` |
| pi SDK 示例 | `examples/sdk/01-minimal.ts` ~ `13-session-runtime.ts`（递进式） |
| beUI agents 组件 | https://beui.dev/components/agents |
| beUI registry | `https://beui.dev/r/{slug}` / `/raw` |
| Beautiful UI 参考 | https://www.beautifului.dev/ |
| markstream-react | https://www.npmjs.com/package/markstream-react |
