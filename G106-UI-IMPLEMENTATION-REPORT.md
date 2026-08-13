# G106 UI Implementation Report

## 已完成

- 将设计 token 收口到 `renderer/src/styles.css`，补齐 `--qx-*` 公共命名、暗色默认和浅色覆盖。
- 调整 Windows 桌面壳层：固定窄导航、sticky 顶部搜索、内容最大宽度、卡片间距和详情抽屉滚动边界。
- 清理主导航中的“控制台（占位）”入口。
- 将来源状态从内部状态码映射为“已连接 / 连接中 / 准备中 / 需要确认 / 暂不可用”等用户文案。
- 将 Runtime、备份恢复、数据目录迁移的原生确认框替换为可访问的统一 `ConfirmDialog`。
- 未修改 Android Runtime、Jianpian Spider、Source Health/Ranking、Auto Fallback、MediaResolver、LocalProxy、hls.js 播放链路。

## 验证

- `npm run typecheck`：PASS
- `npm run renderer:build`：PASS
- `npm test`：PASS（104 files / 545 tests）
