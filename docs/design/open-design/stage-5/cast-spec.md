# Stage 5 Push / Cast design extension

G65 的 Push 入口沿用现有 Neutral Modern workbench，不新增播放器外壳或第二套状态模型。

## Placement

- Push 设置位于现有 Settings 页面，复用 `SettingsSection`、状态 chip、按钮和错误面板。
- 页面显示 localhost endpoint、端口、确认策略、冲突策略、待确认列表和最近 Push。
- 待确认卡只显示来源类型、用户标题和目标域名；完整 URL、请求头和本机路径不进入 renderer。
- LAN 控制在 G65 只显示 `Requires G68 LAN Control`，不提供伪造的网络开关。

## Interaction

- 外部 `push://` 请求先进入待确认状态；用户通过 Play 或 Reject 完成明确决策。
- 已有播放会话时按 Replace、Queue、Reject 执行；Queue 只保留单一播放宿主，停止当前会话后再消费。
- 监听状态、错误和空队列复用现有 settings/error 视觉语言；控件保留键盘焦点和 44px 命中区域。

## State boundary

## G66 DLNA / UPnP extension

- Cast is exposed from the existing playback stage. Discovery is user initiated and returns `CastUiState`; there is no background SSDP loop.
- The main process validates SSDP `LOCATION` before fetching it: HTTP only, no credentials, local/private address resolution, bounded XML, timeout, same-origin control URLs, and no DTD or external entities.
- AVTransport uses a fixed SOAP allowlist. `Seek`, `GetTransportInfo`, and `GetPositionInfo` are called only when the renderer advertises the corresponding SCPD action; unsupported actions return `DLNA_UNSUPPORTED`.
- Direct media URLs are used only when the renderer can reach them without private request headers. Local media, subtitle tracks, and remote headered media use a session-only high-entropy `CastMediaBridge` URL with expiry, byte cap, request-header allowlist, and shutdown revocation.
- The bridge never exposes a directory or arbitrary file path. Cookie/Referer are forwarded only to the configured upstream media request; they are not placed in the SOAP URL or sent to the renderer.
- Device loss changes the session to `DLNA_DEVICE_LOST` and stops further retrying. The UI shows Searching / Devices / Connected / Error plus the device name, model, and status.

PushService 在主进程拥有 HTTP listener、URL/DNS 校验、确认队列和请求头白名单；renderer 只接收
`PushUiState`。投送通过现有 `DesktopPlaybackSession` 或 `LivePlaybackSession` 适配器完成，不能在
renderer 或 PushService 内部维护第三套播放器状态。
