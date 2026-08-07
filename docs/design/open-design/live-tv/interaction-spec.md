# Live source interaction spec

```text
empty → previewing → preview-ready → applied
                  └→ error → retry
saved → refreshing → applied
                  └→ last-known-good + error
saved ↔ disabled
```

- 预览和确认是两个动作；预览失败不改动已保存来源。
- 刷新失败不清空旧频道；来源卡片保留旧计数并显示脱敏错误。
- 停用来源后刷新按钮不可用；启用后才允许手动刷新。
- 移除是显式动作，级联移除该来源频道和线路。
- 所有按钮可通过键盘访问，pending 状态禁用重复提交，错误不通过 URL 猜测而由 typed 状态驱动。
