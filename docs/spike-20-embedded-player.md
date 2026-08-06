# Spike 20：Electron 内嵌 HLS/MP4 播放器

## 状态

G21 已完成本地合同验证和打包版 Electron E2E。运行时仍记录为 Spike 18 的 development-fallback JDK；这不代表正式 Temurin 发布工具链已验证。

## 范围

- `playerContent` 的 `parse=0`、HTTP/HTTPS、无 headers 结果进入独立播放器状态层；
- MP4 和 HLS 使用 Electron 页面内的 `<video>`；
- HLS 在浏览器原生不支持时加载随应用打包的 `hls.js`，不使用 CDN；
- 带 `User-Agent`、`Referer` 等 headers 的结果返回 `PLAYBACK_PROXY_REQUIRED`，留给 G22 LocalProxy；
- `csp_Douban` 继续返回 `PLAYBACK_UNAVAILABLE`，播放按钮保持禁用；
- 本地媒体 fixture 提供一段固化的短 MP4、规范 fMP4 HLS playlist 和 playerContent 响应，并在测试结束后关闭。

## 结构

`EmbeddedPlaybackController` 独立维护：

```text
idle → resolving → loading → playing/paused/ended/stopped/error
```

它还维护进度、时长、音量、静音和全屏状态，并统一拒绝非 `parse=0`、非 HTTP(S) 和带自定义 headers 的来源。

旧的 `DesktopSpiderUiController` 只负责把 session 的播放结果交给该控制层；页面脚本负责 `<video>` 事件和控件。切换来源、关闭页面和 Electron 退出时执行 pause、清空 src、`video.load()`、销毁 HLS 实例并移除监听器。

## Fixture

`src/electron/media-fixture.ts` 只绑定 `127.0.0.1` 随机端口，提供：

- `/player?id=direct-mp4`；
- `/player?id=direct-hls`；
- `/player?id=headered`；
- `/media/fixture.mp4`，含 `Accept-Ranges` 和 Range 响应；
- `/media/fixture.m3u8`，包含初始化片段和 fMP4 media segment；
- `/media/fixture-init.mp4` 与 `/media/fixture-0.m4s`，用于 HLS 实际加载。

它是确定性的本地协议 fixture，不是真实影视源，也不依赖外部网站。

## 验证

- `npm run typecheck`
- `npx vitest run tests/playback.test.ts tests/media-fixture.test.ts tests/player-jvm.test.ts tests/desktop-ui.test.ts tests/electron-e2e.test.ts`
- `npm run electron:e2e:package`

打包 E2E 覆盖 MP4、HLS、Douban 禁播、headers 阻断、无 `window.open`、重启和 JVM sidecar 退出；真实 BrowserWindow 探针还检查 MP4 `readyState`、HLS 本地脚本和 HLS 播放器节点已进入可加载状态。

## G21 禁止项

本 Gate 未实现 LocalProxy、`parse=1`、mpv、Vue 迁移、Android Emulator、真实第三方媒体源、直播、弹幕、下载或收藏业务。
