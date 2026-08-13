# QX影视 G106 Final Design Review

状态：`LOCAL_CODEX_REVIEW = PASS`  
Open Design Cloud：`BLOCKED`（`AMR_INSUFFICIENT_BALANCE`，余额为 0，未生成 Cloud artifact）

## 审查边界

- 审查执行者：Local Codex / Open Design critique skill
- 审查对象：真实仓库中的 QX影视桌面端现有实现
- 覆盖：App Shell、Home、Search、Detail、Source Panel、Player、Runtime、Settings
- 输入：`G106-CLOUD-FINAL-REVIEW-CONTEXT.md`、真实 `renderer/src`、现有本地 after 截图
- 初审阶段：只读审查；未启动应用、未生成新截图、未伪造测试或 Cloud 结果。审查后的最小修正已在仓库中单独落实并完成回归验证
- 保护边界：保留 `--qx-*` Design System V1，不触碰 G101–G105 的 Runtime、Spider、Source Health、Fallback、LocalProxy、hls.js 链路

## 结论

现有 UI 的视觉方向和组件边界足以作为 V1 基础。Local Codex 初审识别的 4 项 RELEASE_BLOCKER 已按最小范围落实；Cloud artifact 仍缺失，因此不能据此签发 Open Design Cloud 或 QX_FINAL_UI_V1。

## RELEASE_BLOCKER

1. Detail 关闭必须保留原 Search / Category 上下文；详情抽屉在滚动场景必须保持当前视口可见。证据：`SpiderView.vue` 的关闭路径回 Home，`styles.css` 的抽屉使用固定文档 `top:292px`。
2. Search 空结果、清筛和无筛选能力状态不得静默回 Home；查询词和列表上下文应保留。没有真实筛选能力时隐藏占位入口。
3. Source Panel 只显示配置中的 site name 或用户可读状态，不回显 `inline:<id>` 等内部 source key。证据：`safe-display.ts` 对短字符串直接原样显示。
4. 统一 ConfirmDialog 补齐焦点移入、Tab 循环、Escape 取消和关闭后恢复，覆盖备份替换、存储迁移、Runtime 卸载等危险动作。

## POLISH

- 播放器只保留一套控制条；不改变 HLS、LocalProxy 或 Playback Pipeline。
- 修正“默认使用浅色”、`Android Runtime READY (ms)` 等面向内部的文案。
- Search / Detail 作为 Browse 子状态保持导航 selected 视觉。
- 将 Runtime READY、毫秒、Host/RPC 等诊断术语收进 disclosure。
- 统一 Settings 中 Backup / Storage / Cache 的中英文标签。

## Local implementation follow-up

四项 RELEASE_BLOCKER 已完成本地修正并验证：

1. Detail 关闭恢复原 Search / Category 上下文和滚动位置。
2. Search 空态提供清除搜索动作，不再把用户静默带回 Home。
3. 来源区域显示配置中的 site name，不显示 `inline:<id>` 内部 key。
4. ConfirmDialog 支持初始焦点、Tab 循环、Escape 取消和关闭后焦点恢复。

对应回归覆盖 `tests/desktop-ui.test.ts` 和 `tests/vue-renderer.test.ts`；全量测试、类型检查、构建和当前预览包 smoke 均已通过。播放器重复控制条等 POLISH 暂不纳入本次修正。

## POST_V1

完整来源筛选、排序、导航层级扩展和播放器重构不纳入本次发布修正。

## Final gate

本地审查已完成，但不能替代 Open Design Cloud。由于 Cloud 调用因余额不足终止且 `artifactCount=0`，`OPEN_DESIGN` 与 `QX_FINAL_UI_V1` 仍保持 `BLOCKED`。
