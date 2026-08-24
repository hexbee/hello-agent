# hello-agent

基于 [pi SDK](https://github.com/earendil-works/pi) 与 Electron 的本地 coding agent 桌面客户端。

- 架构决策与 MVP 边界：[docs/desktop-agent-tech-stack.md](docs/desktop-agent-tech-stack.md)（v0.6，架构冻结）
- Spike 验收结果与宿主模型 ADR：[docs/spike-report.md](docs/spike-report.md)

## 快速开始

```bash
pnpm install
pnpm typecheck && pnpm build   # 类型检查 + 三端产物
pnpm probe:all                 # §10 自动化验收探针（无 DEEPSEEK_API_KEY 时 e2e 自动 SKIP）
DEEPSEEK_API_KEY=sk-... pnpm dev   # 启动桌面应用（模型 deepseek-v4-flash / v4-pro）
```

## 结构

```
apps/desktop          # Electron 应用（main 直嵌 pi SDK + 受限 preload + renderer）
packages/shared       # IPC 契约单一事实来源（事件/命令/运行时校验器）
spikes/probes         # 技术文档 §10 验收探针
docs                  # 架构决策、Spike 报告
```

## 锁定版本

`@earendil-works/pi-coding-agent@0.84.2` · `electron@43.4.1` · `electron-vite@5.0.0` · `typescript@~5.9.3`
Renderer：`react@19.2.8` · `tailwindcss@4.3.3` · `markstream-react@2.0.3`（beUI 后续按需接入）

包管理一律使用 pnpm（`packageManager: pnpm@11.21.0`）。

## 实施状态（v0.1 MVP）

- ✅ Main：PermissionManager / PiAdapter / 隔离工厂 / IPC 校验（Spike 代码直接演进）
- ✅ Renderer：React 产品界面 —— 工作区 Trust 门控、流式 Markdown 对话、工具卡、
  审批卡、会话列表（新建/打开/重命名/删除到废纸篓/从历史分叉）、模型选择
- ✅ 可恢复删除：会话删除走系统废纸篓（仅限应用自有目录）
- ⏳ 待办：auth 流程 UI（当前凭据经环境变量注入）、审计查看界面、打包签名（§10.9）
