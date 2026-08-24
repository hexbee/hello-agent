# Spike 结论与宿主模型 ADR 草稿

> 状态：Spike 主体完成（§10.1–10.8 全部自动化验证通过）；§10.9 完整打包/签名与真实 LLM 端到端待补。
> 日期：2026-08-24
> 对应文档：docs/desktop-agent-tech-stack.md v0.5

## 1. 验收结果总览（对照 §10）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | tool_call → PermissionManager → IPC → approval UI → allow/block 全链路 | ✅ 自动化 + UI 就绪 | `pnpm probe:permission`（22 checks）；审批卡 UI 在 renderer，`approval.resolve` IPC 已接通 |
| 2 | 多 pending / abort / TTL / 重复响应 / 切会话 / 切 cwd / 窗口关闭 / host 退出 的安全取消 | ✅ | permission-probe + dispose-rebuild-probe；切 cwd 复用 replaceSession 语义 |
| 3 | newSession / switchSession / fork 后 `bindExtensions(actualBindings)`，拦截仍生效 | ✅ | session-rebind-probe：每次替换 factory 重新实例化（bindCount 单调递增） |
| 4 | 普通异常后窗口可用、runtime 可 dispose 并同 cwd 重建 | ✅ | dispose-rebuild-probe |
| 5 | 1000+ delta 压测有序、不冻结、无界积压 | ✅ | delta-stress-probe：5000×40B，5 批次、最大排队延迟 18ms、0 丢包、堆有界；Renderer 侧 rAF 卡顿测量内置于 dev.stressDeltas 按钮 |
| 6 | Renderer 只能访问 preload 白名单 | ✅ | sandbox-probe：主世界无 require/process/ipcRenderer，bridge 无泛型 invoke/send |
| 7 | Trust matrix 自动化测试 | ✅（部分） | permission-probe 覆盖 untrusted/restricted/trusted 决策矩阵；项目 extensions/skills 不自动执行由 isolation-probe bait 注入证明 |
| 8 | 文件系统探测隔离断言 | ✅ | isolation-probe：`.pi/extensions` 恶意扩展未执行、`~/.pi/**` 与 `~/.agents/**` 零触碰、trust.json 未写、会话落 app 目录、project_trust 返回 no/false |
| 9 | 含 pi 的打包产物可启动 | ⚠️ 部分 | electron-vite 产物（pi external）已可启动并完成 §10.6 探针；ASAR 打包/签名/notarization 未做 |
| + | 真实 LLM 端到端（DeepSeek） | ✅ | e2e-llm-probe：真实流式 delta（含 thinking）、read 工具自动放行、bash 审批 allow 后执行成功、deny 被 block、会话落 app 目录（14/14；`DEEPSEEK_API_KEY=... pnpm probe:e2e-llm`，无 key 自动 SKIP） |

运行方式：`pnpm probe:all`（共 52+5 项检查，全部 PASS）。

## 2. Spike 中发现并修复的真实问题

1. **macOS symlink 陷阱**：`/var` → `/private/var`。路径边界检查若不对 cwd 做 realpath，会把工作区内路径误判为逃逸。→ PermissionManager 对 cwd 防御性 canonicalize（permission-manager.ts `checkPathBoundary`）。**此问题必须写入实施规范**：一切路径比较基于 canonical path（文档 §4.1 已有要求，Spike 证实其为硬性前提而非洁癖）。
2. **DeltaBatcher 背压**：生产速率 > flush 窗口时触达 maxEvents 上限丢包。→ 安全阀提到 8192 + 生产端周期让出时间片；快照恢复机制兜底丢弃场景。
3. **pi 会话惰性持久化**：JSONL 在首条消息 append 时才写盘。空会话不可 open/switch（`ensureOwnSessionFile` 报 not_found 是正确语义），UI 层需将"未保存会话"与"损坏会话"区分展示。
4. **preload 产物名**：electron-vite 5 对 CJS preload 输出 `.cjs`，主进程引用需一致；sandbox 模式下 preload 必须 CJS。
5. **workspace 依赖打包边界**：`@spike/shared` 入口是 TS 源码，必须 bundle 进 main（externalizeDepsPlugin exclude），只有 pi 保持 external。

## 3. ADR 草稿：宿主模型（§2.1 冻结条件）

### 决定

**v0.1 采用 Pi 直嵌 Main。**

### 理由

- 直嵌方案下，§10.2 要求的全部取消语义已在单进程内验证：审批 Promise 由 PermissionManager 持有，abort/session 替换/dispose 均能同步取消并向 pi 返回 block，无需跨进程协议。
- dispose + 同 cwd 重建可重入（dispose-rebuild-probe），每步有 3s 超时兜底，满足 §4.5 的普通异常恢复目标。
- 事件管道（合批、序号、背压）在单进程内即可保证有序与有界；跨进程反而要重做日志、认证、cwd、pending approval 的序列化。

### 直嵌方案的已知风险与缓解（遗留为实施期任务）

| 风险 | 缓解 | 状态 |
|---|---|---|
| OOM / 原生崩溃拖垮 Main（窗口同死） | Electron 主进程崩溃即整应用退出是可接受的产品语义（单窗口应用）；崩溃报告留待 §9.2 发布决策 | 记录，不阻塞 |
| Agent 死循环阻塞 Main 事件循环 | pi 的 LLM/工具 IO 均为异步；未观测到同步阻塞。实施期加 watchdog（agent_settled 心跳超时 → failed 态） | **已实施**：PiAdapter 内置 watchdog（默认 180s，host.watchdogTimeoutMs 可配），任意 pi 事件重置；超时 → `agent.failed(runtime)` + abort。卡死注入测试见 `pnpm probe:watchdog`（9/9） |
| 卡死量化 | Spike 以探针覆盖异常路径；真实"卡死"注入（如阻塞工具）未做 | **已关闭**：`probe:watchdog` 用永不返回的 tool_call handler 真实注入卡死，验证 watchdog 触发与 rebuild 恢复 |

### 触发重新评估的条件

- 引入多窗口/多工作区并行（Renderer 崩溃隔离需求上升）
- 出现同步阻塞型工具或原生插件
- 需要在 Agent 崩溃后保持窗口会话

## 4. 遗留事项（进入实施前必须关闭）

1. ~~真实 LLM 端到端~~ **已完成**：DeepSeek provider（deepseek-v4-flash/pro）验证通过，环境变量鉴权由 pi 原生解析。附带修复：`safePreview` 的 allowlist 序列化原先把工具结果嵌套结构剥空，现改为顶层 allowlist + 嵌套截断透传。
2. **§10.9 打包**：electron-builder 配置、ASAR 规则（pi external unpack）、签名与 notarization。
3. ~~卡死注入测试~~ **已完成**：`pnpm probe:watchdog` —— bash tool_call 被挂起扩展拦截后事件流静默，watchdog 在窗口期后发出 `agent.failed(runtime)` 并 abort；释放后 `rebuild()` 重建 runtime、重新绑定扩展、恢复会话（9/9）。
4. **审计 SQLite 化**：当前 JSONL 审计文件满足 §7.2 最小闭环；schema 归入 §1.2 未决项。
5. CredentialStore 持久化（Keychain）—— **已完成**：SafeStorageCredentialStore（§8），`pnpm probe:auth` 验证加密落盘与 ModelRuntime 解析。

## 5. 构建决策记录（§9.2 要求开工前确定）

- 工具链：**electron-vite 5**（Main/preload/renderer 一体构建；CJS preload；@spike/shared bundle、pi external）。
- 包管理：**pnpm workspace**，精确版本锁定（electron 43.4.1 / electron-vite 5.0.0 / pi-coding-agent 0.84.2 / pi-ai 0.84.2 / TS ~5.9.3）。
- 平台矩阵、签名、更新通道：随 §10.9 关闭时补充记录。

## 6. 复现实验

```bash
pnpm install
pnpm typecheck && pnpm build   # 类型与三端产物
pnpm probe:all                 # §10 自动化验收（isolation/permission/rebuild/delta/sandbox）
pnpm dev                       # 手动体验：打开目录 → Trust → prompt → 审批卡 → 压测按钮
```

带 key 的端到端：`DEEPSEEK_API_KEY=sk-... pnpm probe:e2e-llm`（或 `pnpm dev` 手动体验；模型选 `deepseek/deepseek-v4-flash` 或 `deepseek/deepseek-v4-pro`）
