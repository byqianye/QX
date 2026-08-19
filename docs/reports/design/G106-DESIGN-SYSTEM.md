# G106 Design System V1

状态：`PASS（本地实现）`；Open Design Cloud 产出：`OPEN_DESIGN_UNAVAILABLE`

## Token 入口

所有 renderer 样式集中在 `renderer/src/styles.css`。新增并使用以下公共 token：

- `--qx-bg-primary` / `--qx-bg-secondary` / `--qx-bg-elevated`
- `--qx-text-primary` / `--qx-text-secondary` / `--qx-text-muted`
- `--qx-border` / `--qx-accent` / `--qx-success` / `--qx-warning` / `--qx-error`
- `--qx-radius-sm` / `--qx-radius-md` / `--qx-radius-lg`
- `--qx-space-1` 至 `--qx-space-12`
- `--qx-shadow-sm` / `--qx-shadow-md` / `--qx-shadow-lg`

旧 token 仍保留为兼容别名，避免一次性改动全部业务组件。暗色为新用户默认主题，浅色主题仍通过同一组 token 覆盖实现。

## 组件规则

现有 Vue 组件继续作为实现边界：`MediaCard`、`SourceSwitcher`、`DetailDrawer`、`PlaybackSelector`、`EmbeddedPlayer`、`SettingsSection`、`EmptyState`、`LoadingState`、`ErrorState`。新增 `ConfirmDialog`，用于 Runtime、备份和存储迁移确认，替代 `window.confirm()`。

交互约束：最小 44px 命中区、`focus-visible` 焦点环、Escape 关闭确认层、状态文案优先于原始内部错误码，播放器和来源核心逻辑不在本层改写。
