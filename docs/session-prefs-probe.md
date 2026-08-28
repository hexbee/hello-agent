# Session prefs probe (session-prefs-probe)

Verifies the permission-mode / model inheritance contract:

- **新对话**（`newSession`）继承当前（= 全局最后一次，跨项目）的权限模式与模型
- **切换会话**（`openSession`）恢复该目录最后一次的权限模式与模型（目录记忆优先于会话文件里记录的旧模型）
- **切换项目**（`create`）有目录记忆时恢复目录记忆，无记忆时沿用切换前的选择
- 偏好持久化到 `session-prefs.json`，进程重建（重启）后依然生效
- 受限（restricted）工作区不恢复「完全访问」

Run: `pnpm probe:session-prefs`
