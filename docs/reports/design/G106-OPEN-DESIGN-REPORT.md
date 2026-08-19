# G106 Open Design Report

状态：`OPEN_DESIGN = BLOCKED`

## 已执行

- 已读取 G106 规范、仓库现有 Open Design 文档和 renderer 代码。
- 已生成当前 UI 基线截图，覆盖导入页、设置页、启动状态和明暗主题，保存在 `tmp/g106-baseline/`。
- 已按 Open Design 流程完成 brief 确认、Cloud 登录状态检查、代理检查和项目创建。
- 已正式提交一次 Open Design Cloud 设计委托。
- 已完成 G106-I 的集成、工作区和项目绑定审计，详见 [docs/reports/design/OPEN-DESIGN-INTEGRATION-AUDIT.md](C:/Users/qiany/Documents/ChatGPT/QX影视/docs/reports/design/OPEN-DESIGN-INTEGRATION-AUDIT.md)。

## 历史阻塞原因（已解决）

Open Design Cloud 返回 `AMR_WORKSPACE_SCOPE_REQUIRED`：项目需要先从 Personal Workspace 打开，当前桌面会话没有该工作区上下文。审计确认：Open Design 登录有效，但活动上下文为 inactive，项目 `workspaceId` 为 `null`，项目文件为空；失败发生在本地 daemon 接收 `start_run` 后、AMR Cloud run 创建前的 workspace scope 校验，不是 QX 代码、Android Runtime 或 VMware 环境问题。

本 Goal 未偷偷切换到 Local Codex，也未用无关模板替代设计委托；后续实现仅沿用仓库已有的 `docs/design/open-design/` 规范和现有组件结构。

## 当前 Cloud 状态

最新官方 Cloud run 已接受项目的 persisted workspace binding，证明 `AMR_WORKSPACE_SCOPE_REQUIRED` 已解决；终态为 `AMR_INSUFFICIENT_BALANCE`，`failureCategory=insufficient_balance`，`failureAction=recharge`，`artifactCount=0`。当前阻塞属于 Open Design Cloud / AMR 外部余额条件，不是 QX 项目、Codex workspace 或 Android/VMware 环境问题。

## G106-I 结论

- `OPEN-DESIGN-INTEGRATION-AUDIT`：`PASS`
- Open Design Cloud 调用：`FAIL`（`AMR_INSUFFICIENT_BALANCE`）
- 最终设计系统审查：`BLOCKED`（无 Cloud artifact）
- 逐页真实界面审查：Local Codex 已完成；Cloud 逐页审查 `BLOCKED`
- Open Design Cloud 产物：`NOT GENERATED`
- `NEEDS_USER_ACTION`：完成 AMR 账户充值后，使用原始 G106 Final Design Review 请求继续运行；无需再次修改 QX workspace scope。

本轮在 Local Codex 审查后仅落实 4 项 RELEASE_BLOCKER 的最小修正：Detail 返回上下文、Search 空态动作、Source Panel 用户可读名称和 ConfirmDialog 焦点安全；没有修改 Android Runtime、Host、Source Health、Fallback、LocalProxy 或播放器核心，也没有把本地结果扩大成 Open Design Cloud 审查通过。

## 恢复检查

用户操作后活动项目焦点已显示为 active，但项目读取和 artifact 读取仍返回 `WORKSPACE_CONTEXT_REQUIRED: an explicit workspace context is required`，项目列表为空。说明项目页面焦点已建立，但尚未从带 Personal Workspace scope 的上下文打开。未再次发起 Cloud run；`OPEN_DESIGN` 和 `QX_FINAL_UI_V1` 继续保持 BLOCKED。

重新打开后进一步验证：按原项目 ID调用官方项目创建入口返回 `UNIQUE constraint failed: projects.id`，证明项目已存在但被无 scope 查询隐藏；没有新建第二个项目。网页入口要求独立邮箱登录，未用它绕过 MCP workspace scope。

## 外部服务阻塞

只读 SQLite 与 daemon 日志确认目标项目已有 `personal/active` workspace 绑定，daemon 也报告 workspace verified；但 Open Design MCP 仍返回空项目或 `WORKSPACE_CONTEXT_REQUIRED`。因此根因已定位为 Open Design MCP/Cloud 的 workspace scope propagation，而非 QX 项目或用户尚未打开 workspace。记录 `EXTERNAL_SERVICE_BLOCKER`，不修改 QX 代码、不注入 scope、不重复启动 Cloud。

本轮还修复了 MCP 注册版本错配：旧注册指向 0.18.1，新注册已指向当前 0.19.0。由于当前 Codex 任务中的旧 MCP 进程不会热加载配置，需在新的 Codex 任务中继续同一 Goal 后再验证 scope；在此之前不宣称 Open Design 恢复或 PASS。

旧 MCP 子进程已被安全终止以避免继续使用错误版本；桌面应用未关闭。当前任务的 Open Design 传输已关闭，后续必须从更新后的注册启动新任务连接。

## 当前设计判断

现有 UI 已有可用的桌面壳层、真实数据绑定、详情抽屉、播放线路、播放器、设置与 Runtime 状态组件。本轮只做与 G106 直接相关的 token 化、层级/密度、状态文案、确认交互和导航清理，未触碰 Runtime、Source Health、Fallback、LocalProxy 或播放器核心。

## 用户明确选择 Local Codex 后的本地审查

用户明确要求“用本地”后，已使用 Local Codex 对真实仓库和既有界面证据完成只读 FINAL DESIGN REVIEW。报告已保存为：

- [docs/reports/design/OPEN-DESIGN-FINAL-REVIEW.md](C:/Users/qiany/Documents/ChatGPT/QX影视/docs/reports/design/OPEN-DESIGN-FINAL-REVIEW.md)
- [docs/reports/design/OPEN-DESIGN-DESIGN-SYSTEM-REVIEW.md](C:/Users/qiany/Documents/ChatGPT/QX影视/docs/reports/design/OPEN-DESIGN-DESIGN-SYSTEM-REVIEW.md)
- [docs/reports/design/OPEN-DESIGN-PAGE-REVIEW.md](C:/Users/qiany/Documents/ChatGPT/QX影视/docs/reports/design/OPEN-DESIGN-PAGE-REVIEW.md)

本地审查结论：视觉基线可保留，发现 4 项 RELEASE_BLOCKER：Detail 返回丢上下文、Search 空态/清筛回 Home、Source Panel 暴露内部 source key、ConfirmDialog 缺完整焦点安全。随后已按最小范围落实这 4 项修正，并用新增回归测试、全量测试、类型检查和重建后的 packaged smoke 验证。播放器重复控制条、内部 Runtime 文案和 Settings 层级保留为后续 POLISH，不扩大本 Goal 范围。

该本地结果不改变 Cloud 状态：`OPEN_DESIGN_CLOUD_CALL = FAIL`，原因为 `AMR_INSUFFICIENT_BALANCE`，`artifactCount=0`；因此 `OPEN_DESIGN` 和 `QX_FINAL_UI_V1` 继续为 `BLOCKED`。

## Personal Workspace 恢复后的最新状态

新任务中已确认 Personal Workspace、项目读取和 Open Design MCP 均恢复；Cloud 登录有效。随后对现有项目启动了真实 `example-critique` FINAL DESIGN REVIEW，但 Cloud 返回：

```text
OPEN_DESIGN_CLOUD_CALL = FAIL
AMR_INSUFFICIENT_BALANCE
artifactCount = 0
```

因此 `OPEN_DESIGN_FINAL_REVIEW`、`OPEN_DESIGN_ARTIFACT` 和 `QX_FINAL_UI_V1` 仍不能判定 PASS。当前阻塞已从 workspace scope 变更为 AMR 余额不足。Local Codex 仅作为用户明确选择的本地审查路径；本地修正不替代 Cloud artifact。

## Local Codex 修正落实与验证

已落实的最小修正：

- Detail 关闭恢复原 Search / Category 页面和滚动位置，不再重新发起 Spider 请求。
- Search 空结果提供“清除搜索”动作，保留搜索上下文；移除无真实能力的 FilterPanel 占位入口。
- Sidebar、顶栏、来源切换、详情和诊断区域使用配置中的 site name，不直接显示 `inline:<id>`。
- ConfirmDialog 增加初始焦点、Tab/Shift+Tab 循环、Escape 取消和关闭后的焦点恢复。

验证结果：

- `npm test`：PASS，104 个测试文件、548 个测试。
- `npm run typecheck`：PASS。
- `npm run build`：PASS。
- `npm run android-host:build`：PASS。
- `npm run prepack-check`：PASS。
- `npm run preview:smoke`：PASS，使用本轮重建的 `release/preview/win-unpacked/QX影视.exe`。
- 当前预览 NSIS 安装态：安装、快捷方式、打包启动、卸载和用户数据保留均 PASS。

本地实现状态为 `G106_LOCAL_UI_IMPLEMENTATION = PASS`；Cloud 仍为 `OPEN_DESIGN_CLOUD_CALL = FAIL`（`AMR_INSUFFICIENT_BALANCE`，`artifactCount=0`），所以最终 `OPEN_DESIGN` 和 `QX_FINAL_UI_V1` 继续为 `BLOCKED`。
