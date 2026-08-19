# QX影视 G106 Design System Review

审查来源：`Local Codex / Open Design critique skill`  
审查状态：`LOCAL_CODEX_REVIEW = PASS`；不代表 Open Design Cloud PASS。

## 评分

| 维度 | 评分 | 判断 |
| --- | ---: | --- |
| 哲学一致性 | 7/10 | `--qx-*` token、暗色默认、壳层与来源表面语言一致；存在 source key 和文案漂移 |
| 视觉层级 | 6/10 | 页面标题、来源切换、媒体网格清楚；Settings 过平，详情滚动定位有风险 |
| 细节执行 | 6/10 | 焦点、最小点击尺寸、媒体卡已具备；顶栏高度、抽屉定位、重复控制条需收口 |
| 功能性 | 5/10 | 真实组件边界完整，但 Detail/Search 空态会丢上下文，ConfirmDialog 缺焦点安全 |
| 创新性 | 5/10 | V1 的克制是合理选择；不应为提高分数新增动效或功能 |

## KEEP

- 保留 `styles.css` 中 `--qx-*` token 入口、暗色默认与浅色覆盖。
- 保留 `AppSidebar`、`TopSearchBar`、`SourceSwitcher` 的工作区壳层结构。
- 保留错误恢复动作和播放健康状态表达。
- 将 `TrustConfirmationDialog` 的焦点模式复用于统一 ConfirmDialog。

## Design-system 修正原则

- 所有小调整继续通过现有 token 完成，不引入第二套颜色或大量页面级硬编码色值。
- 内部运行时术语只出现在诊断 disclosure；主路径使用用户可理解的状态文案。
- 视觉修正不得改变 Android Runtime、Host、Source Health、Fallback、LocalProxy 或 hls.js 行为。

## 本地审查证据边界

Local Codex 初审只读取了真实仓库和既有截图；随后仓库按初审建议完成最小修正。修正后的回归由项目测试和 packaged smoke 单独验证，不把本地验证结果写成 Open Design Cloud artifact。

## 修正后状态

- Source Panel 的用户路径使用 site name，内部 `inline:<id>` 仅保留在诊断/标识层。
- Search 空态和 Detail 返回保持 Browse 上下文。
- ConfirmDialog 已补齐焦点移入、Tab 循环、Escape 取消和关闭后恢复。
- `--qx-*` token、暗色默认和现有壳层边界保持不变。

本地实现：`G106_LOCAL_UI_IMPLEMENTATION = PASS`。Cloud 仍因 `AMR_INSUFFICIENT_BALANCE`、`artifactCount=0` 无法生成 artifact。
