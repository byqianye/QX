# Live source components

G56 使用以下最小组件语义：

- `LiveSourcesView`：页面容器和状态编排。
- 导入表单：名称、M3U/TXT URL 或文件、预览动作。
- 预览摘要：统计、频道名、行级诊断、确认/清除动作。
- 来源卡片：来源类型、脱敏定位、频道/分组/线路数量、启停/刷新/移除动作。

组件不得接收或渲染 `LiveChannelStreamRecord.url`、headers 或 raw playlist；这些字段只存在主进程服务和数据库层。
