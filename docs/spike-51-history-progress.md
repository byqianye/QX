# Spike 51：播放历史与进度

## Goal

为每条来源内容建立稳定的播放历史身份，把播放进度写入 SQLite，并提供可确认的恢复、完成、删除和隐私控制。

## 状态

已完成（G51）。G50 的 `history`、`playback_progress` 表与 `PlaybackProgressWriter` 作为数据基础；不引入真实影视源或第三方解析能力。

## 决策

- 身份为 `sourceId + vodId + seasonId? + episodeId?` 的长度无歧义编码；不使用标题作为主键。来源 ID 是规范化来源描述的 SHA-256 前缀，来源显示名只保留 host 或安全短名称。
- 历史记录只保存标题、海报安全值、集数、线路显示名、位置、时长、更新时间、完成状态和安全来源名。临时播放 URL、Proxy token、Cookie、Authorization 不进入 SQLite。
- 起播成功由 `first-frame` 或 `playing` 同步确认；播放同步使用 750ms debounce、5s interval，并在 pause、stop、换集、应用关闭时 flush。
- 完成判定为实际 `ended`，或有效时长下播放比例达到 90%，或时长至少 300 秒且剩余不超过 90 秒；60 秒以下的媒体不因剩余时间规则提前完成。
- 打开详情只展示“继续播放”提示，不自动 seek。用户必须明确选择继续、从头播放或删除进度；已完成记录仍保留两种播放策略。
- 跨线路优先按原线路名称，再按 episode ID 匹配；原线路不存在时只按 episode ID 尝试，无法确认集身份时只保留详情，不自动播放。
- 历史默认保留。暂停记录只阻止新的播放写入，不清除已有记录；清空历史同时删除 progress 行，并使用 SQLite transaction。
- 已完成记录不自动播放；History 页面以“从头播放”进入详情，详情页仍要求用户明确选择从头或继续。

## 验收与验证

- `tests/history-progress.test.ts`：身份隔离、debounce/flush、完成规则、跨线路恢复、暂停/清除、敏感数据边界。
- `tests/desktop-ui.test.ts`：播放成功后的历史创建、重启后的 resume candidate、明确选择后 seek。
- `tests/vue-renderer.test.ts`：正式 History 页面、筛选控件、删除确认、Sidebar 路由。
- 目标验证命令：

  ```powershell
  npm run typecheck
  npx vitest run tests/history-progress.test.ts tests/desktop-ui.test.ts tests/vue-renderer.test.ts
  npm test
  npm run electron:build
  npm run electron:package:win
  npm run electron:e2e:package
  ```

## 风险与未完成

- 本地 fixture 不等同于真实影视源；真实源仍按现有 Spider/Proxy 边界处理。
- packaged first/restart E2E 已验证历史写入、重启后恢复候选、脱敏字段和 sidecar/resource cleanup；Electron main 在关闭 DB 前 flush history service。
