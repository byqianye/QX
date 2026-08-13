# G106 Visual QA

## 基线

基线截图在 `tmp/g106-baseline/`，包含导入页、设置页、启动状态以及浅色/暗色状态。基线显示现有布局已经是桌面工作台方向，但存在默认浅色、设置页层级偏平、占位控制台入口、来源原始状态文案和原生确认框等收口问题。

## 本轮检查

- token 只在 `renderer/src/styles.css` 集中定义；组件未新增渐变、玻璃或外部字体。
- 导航、顶部搜索和内容区保留明确层级；详情抽屉增加视口内滚动上限，避免长简介/大量线路撑出窗口。
- 交互控件保持至少 44px 命中区并保留 `focus-visible`。
- `prefers-reduced-motion` 规则继续生效。
- 已执行 typecheck、renderer build 和全量 Vitest。
- 已对重建后的 preview packaged smoke 生成 after 截图，并通过导入、设置、Runtime ready 状态、播放器和重启流程检查。

## Local Codex 修正后的回归

Local Codex 初审提出的 4 项 RELEASE_BLOCKER 已落实：Detail 返回恢复 Search / Category 上下文和滚动位置；Search 空态提供清除搜索动作；来源区域显示 site name；ConfirmDialog 完成焦点移入、Tab 循环、Escape 取消和关闭后焦点恢复。对应新增回归测试已通过，全量测试 548/548 通过。

最新重建的 `win-unpacked` 预览包通过 `npm run preview:smoke`，当前 NSIS 预览安装态通过安装、快捷方式、打包启动、卸载和用户数据保留检查。未修改 Android Runtime、Host、Source Health、Fallback、LocalProxy 或播放器核心。

## 未完成

由于 Open Design Cloud 当前因 `AMR_INSUFFICIENT_BALANCE` 失败且 `artifactCount=0`，尚未完成 Open Design 产物对照的逐页截图审查；本轮 after 截图使用 packaged fixture，真实 Jianpian 截图仍由 G105 的 Clean E2E 证据覆盖。G106-I 已完成集成审计，但没有伪造 Cloud 设计结果或逐页 review PASS。

阻塞证据与必须的 Personal Workspace 操作见 [OPEN-DESIGN-INTEGRATION-AUDIT.md](C:/Users/qiany/Documents/ChatGPT/QX影视/OPEN-DESIGN-INTEGRATION-AUDIT.md)。
