# QX 页面规格

## 全局壳层

`AppSidebar` 负责一级导航和来源连接摘要；`TopSearchBar` 高 64px，只负责全局搜索和当前来源上下文；内容区使用 24px gutter；`DetailDrawer` 保留浏览上下文，不把用户带离列表。

首屏顺序：页面标题与连接摘要 → `SourceSwitcher` → `CategoryTabs` → `FilterPanel` → `MediaGrid`。设置与诊断使用 `SettingsSection` 分组，不做虚构指标仪表盘。

## 浏览、搜索与详情

- 浏览页展示来源、分类、筛选、媒体网格；未连接或无结果必须分别说明原因并给出下一步。
- 搜索保留查询词和当前来源；空结果提供清除筛选，网络错误提供重试，不静默跳回首页。
- 点击 `MediaCard` 打开右侧 `DetailDrawer`，顺序为封面/标题、来源/线路状态、简介元数据、可播放线路、播放主动作。
- 未信任来源或首次启用 LocalProxy 时先显示 `TrustConfirmationDialog`。
- 抽屉和诊断不展示密钥、token、完整敏感 URL 或内部堆栈。

## 播放

首屏主位为 `EmbeddedPlayer` 与 `PlayerControls`，其后是 `PlaybackLineTabs`、`EpisodeGrid` 和 `DiagnosticPanel`。线路标签显示人类可读名称、MP4/HLS 协议和状态。

- `Proxy Required`：说明需要本机代理；主动作启用代理并重试，次动作换线路。
- `Playback Unavailable`：说明当前线路暂时无法播放；主动作重试当前线路，次动作切换线路。
- 播放器错误不能覆盖控制区；错误区域必须提供可恢复动作。

## 设置与诊断

设置至少包括来源管理、LocalProxy、播放偏好、诊断与日志、隐私的分组语义；凭据只显示状态。诊断按来源请求、线路解析、CDN 响应、LocalProxy、播放器能力分层，并提供脱敏摘要。

## 窗口验收

| 窗口 | 验收 |
| --- | --- |
| 1280×720 | 侧栏、搜索、来源切换、4 列网格、播放器控制完整可用 |
| 1440×900 | 5 列网格、详情抽屉、线路/分集区无碰撞 |
| 1920×1080 | 最大内容宽度受控、6–7 列网格、抽屉不被拉宽、播放器比例稳定 |
