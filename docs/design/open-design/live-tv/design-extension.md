# Live TV Open Design extension

本扩展继承现有桌面工作台的 sidebar、workspace header、`SettingsSection`、`panel`、状态 chip、键盘焦点和浅/深色 token。直播源管理是工作台中的一个可持久化页面，不采用客厅电视启动器、全屏频道墙或新的配色体系。

## G56 页面边界

- 页面入口：侧栏「直播源」，持久化 navigation 为 `live`。
- 页面职责：来源添加、预览、确认、刷新、启停、移除和解析诊断。
- G56 不放播放器、EPG 网格、节目单时间轴或后台自动刷新控件。
- 远程地址可显示为来源定位摘要；不显示凭据、raw playlist、请求头或完整敏感 URL。

## 视觉规则

- 使用现有 `--surface`、`--border`、`--muted`、`--warn`、`--accent` token。
- 预览和来源卡片保持信息密度适中的两列布局；窄屏时按钮换行。
- 所有动作按钮保持现有最小触控尺寸和 focus-visible 行为。
