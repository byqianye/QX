# G44 隔离 Electron 网页嗅探

## 状态

已完成。G44 只在显式启用时提供 `parse=1` 解析失败后的隔离嗅探回退；默认启动路径不会创建嗅探窗口，也不会扫描任意网页。

## 合同

`IsolatedSniffer` 接收 source、playback session、初始 HTTP(S) URL、显式 origin allowlist 和资源/页面/时间上限。每次 `sniff()` 都生成独立的 `temp:qx-sniffer-*` partition，并通过 `IsolatedSnifferPlatform` 创建会话。

会话策略固定为：

- `contextIsolation=true`
- `nodeIntegration=false`
- `sandbox=true`
- `webSecurity=true`
- 禁用下载、弹窗和新窗口
- 只允许 allowlist 内的 HTTP(S) origin

Electron 适配层使用 `session.fromPartition(..., { cache: false })`、隐藏 BrowserWindow 和 `webRequest` 观察请求/响应。关闭时先移除监听器、停止并销毁窗口，再清理该 partition 的 storage data；不会复用主窗口 Cookie。

## 候选与安全边界

候选必须通过协议、origin、状态码和可访问性检查，并依据 Content-Type、m3u8/mp4/媒体分片扩展、媒体资源类型、显式播放器请求、Content-Length、请求耗时、页面关联和 master playlist 信号评分。图片、CSS、JavaScript、JSON、普通 API、tracker 和失败响应不能成为最终媒体。

最终结果只保留必要请求头（Accept、Accept-Language、Origin、Range、Referer、User-Agent），Cookie、Authorization、Set-Cookie 和含换行值不会进入结果或诊断。带 header 的结果继续交给现有 LocalProxy；无 header 的直接媒体沿用既有 direct playback seam。

初始地址、重定向、资源数、页面数、总时间和空闲时间均受限。`file:`、`data:`、`javascript:`、`devtools:`、本地文件、外部 origin、弹窗、新标签和下载都会被阻止；超时、取消、窗口关闭或策略违规会清理活动 session。

## Fixture 与验证

`src/electron/media-fixture.ts` 提供延迟 `/sniff/delayed.m3u8`，页面同时请求 poster、脚本和 JSON 假候选。纯策略测试覆盖跨 origin、非法协议、弹窗、无限加载、超时、AbortSignal、关闭清理和 Cookie 隔离；桌面 UI 测试覆盖 parser 失败后回退到 `isolated-sniffer`；packaged E2E 在首次启动和重启轮次均检查真实隐藏 Electron 嗅探窗口捕获延迟 m3u8，并确认诊断不含 Cookie。

## 明确限制

G44 不实现任意网页 DOM 扫描、mpv backend、字幕、线路自动回退或未授权第三方源。嗅探只由应用配置显式启用，并且仍然受 origin allowlist 和本地 fixture/受控源边界约束。
