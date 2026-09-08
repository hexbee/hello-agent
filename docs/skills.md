# Skills

桌面应用复用 Pi 0.84.4 的 DefaultResourceLoader，保留官方发现、过滤、重名处理和诊断行为。

支持的来源：

- 全局 `~/.pi/agent/skills/`、`~/.agents/skills/`；`PI_CODING_AGENT_DIR` 可覆盖 Pi 全局配置目录。
- 已信任项目的 `.pi/skills/`，以及 cwd 到 Git 根目录之间各层 `.agents/skills/`（非 Git 项目到文件系统根目录）。
- 全局和项目 `.pi/settings.json` 中的 `skills` 自定义文件/目录与 `packages` 包资源。默认全局 settings 位于 `~/.pi/agent/settings.json`；相对路径、过滤和包 manifest 的 `pi.skills` 规则由 Pi 处理。
- 启动参数 `--skill <path>`（可重复）或 `--skill=<path>`，对应 Pi 显式附加路径。

受限工作区只自动加载全局资源；项目资源在工作区信任后加载。Skill 内容不改变工具权限。Skills 发现使用独立的官方目录 loader，其结果注入应用会话，其他 CLI extensions、模型、凭证与会话配置不随之启用。

输入框输入 `/` 或 `/skill:` 打开选择列表，可按名称或描述搜索；↑↓ 切换，Enter/Tab 补全，Esc 关闭，也可点击拼图按钮选择。选择后插入 `/skill:name `，可追加参数再发送。按钮打开列表时保留已有草稿，选中 skill 后把草稿作为参数。加载诊断在列表底部展开，悬停条目查看路径。

会话系统提示词只包含 skill 元数据，模型按需读取正文；`disable-model-invocation: true` 隐藏自动发现提示但仍可在列表选择。显式命令由 SDK 读取 SKILL.md、展开正文与相对路径上下文。新建、切换、分叉和重建会话通过统一工厂重新发现；没有文件监听，修改 skill 后新建或重建会话刷新目录。

验证：`pnpm probe:skills` 使用临时目录，离线检查官方路径、settings、package、显式路径、信任状态、重名与无效文件、提示词注入、显式命令展开及新会话发现。
