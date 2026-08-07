# Spike 57：直播频道目录与播放

## Goal 状态

- 状态：已完成
- 依赖：G56 直播源导入，checkpoint `a597e87c757e534b5b4d69c242963729ab04784d`
- checkpoint：`checkpoint: complete G57 live playback`

## 范围

G57 在 G56 的安全来源和频道线路数据之上，建立一套独立的直播播放会话：

- `LivePlaybackService` 负责频道/线路解析、单会话生命周期、切换代数、
  `AbortController` 取消和播放错误映射。
- 复用既有 `EmbeddedPlaybackController`、`PlayerBackend` 能力边界和
  `PlaybackProxyServer`；无请求头的 HTTP(S) HLS/媒体地址直连，有请求头的线路经
  LocalProxy 转换为播放器可访问的 loopback URL。
- `LiveCatalogUiState` 只返回来源摘要、分组、频道元数据、线路 label/protocol/status
  和最近播放标识；raw URL、headers、raw playlist 不进入频道目录状态。
- 直播页面提供分组筛选、首批 40 条窗口化频道、滚动追加、键盘上下/回车选择、手动
  线路选择、播放器状态和最近频道入口；节目单和健康数据仍显示为占位状态。
- SQLite schema v5 增加 `live_recent`，只保存 `channel_id`、`source_id`、时间和最近
  `stream_id`，并通过来源/频道删除级联清理。

## 播放会话模型

会话状态为 `idle → resolving → loading → playing/buffering`，切换时进入
`switching`，失败进入 `error`，停止后保留 `stopped` 摘要供 UI 收尾。每次选择获得
递增 generation；新选择先取消旧 `AbortController`，旧 proxy session 也会被关闭。
只有当前 generation 可以写入播放器、recent 和错误状态，因此快速切换不会让旧请求
覆盖新频道。

支持的产品边界是 HTTP(S) 线路、HTML video 和 HLS.js；`mpv` 仍只是既有后端能力的
类型边界，不在此 Goal 打包 mpv。这里没有声称支持所有 IPTV、DRM/解密、内置真实电视
源、全频道自动合并或 Android DEX。

错误使用稳定 code：`LIVE_SOURCE_UNAVAILABLE`、`LIVE_CHANNEL_UNAVAILABLE`、
`LIVE_STREAM_UNAVAILABLE`、`LIVE_PROTOCOL_UNSUPPORTED`、`LIVE_STREAM_FAILED`、
`LIVE_STREAM_TIMEOUT` 和 `LIVE_SWITCH_CANCELLED`。来源停用、移除或刷新后，当前会话
会停止，目录只保留启用来源的频道。

## Fixture 与验证边界

`MediaFixtureServer` 的 `livePlaybackUrl` 提供五个可重复场景：A 直连 HLS、B 需要
Referer/User-Agent 的受保护 HLS、C 500、D 延迟失败、E 同频道双线路（首条失败、第二条
可用）。测试覆盖直接播放、LocalProxy 头部转发、线路切换、超时/错误映射、快速切换的
generation 取消、recent 持久化、来源停用和 UI API。

数据库隐私检查确认 `live_sources`、`live_channels`、`live_channel_streams` 和
`live_recent` 不含 token、Cookie、authorization、bearer、api-key、password 或 secret
模式；LocalProxy token 只存在内存会话和受控播放器 URL 中，停止/退出时撤销。

## 验证命令

```powershell
npm run typecheck
npx vitest run tests/live-playback.test.ts tests/live-playback-ui.test.ts tests/live-source.test.ts tests/live-ui.test.ts tests/sqlite-data-layer.test.ts tests/media-fixture.test.ts tests/vue-renderer.test.ts
npm test
npm run renderer:build
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
git diff --check
```

## 后续明确不属于 G57

G58 负责 EPG 导入与节目单；G59 负责匹配与当前/下一档展示；G60 负责 SmartChannel；
G61 负责健康指标、故障切换和 Stage 4 收口。G57 不实现自动切源、自动节目单匹配、
全频道 Smart 合并、DRM 绕过、第三方真实源发现或 Android DEX 兼容。
