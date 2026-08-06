# Spike 23：授权 Jellyfin 媒体源

## 状态

G24 的 Jellyfin 适配器与本地协议合同实现已完成。当前工作区没有 `QX_JELLYFIN_URL`、`QX_JELLYFIN_TOKEN`、`QX_JELLYFIN_USER_ID` 三个环境变量，因此真实服务器验证状态为 `external-environment-blocked`；这不代表真实 Jellyfin 已验证，也不阻塞后续 Goal。

## 配置与安全边界

适配器读取：

```text
QX_JELLYFIN_URL
QX_JELLYFIN_TOKEN
QX_JELLYFIN_USER_ID
```

配置只接受 HTTP(S) URL，拒绝 URL 凭据、查询参数、fragment 和其他协议。API 请求通过 `X-Emby-Token` 认证。配置错误、HTTP 错误、Direct Play 能力错误和网络超时均返回稳定错误码，不把 URL、用户 ID、token、响应体或密码写入错误消息。

真实值不得进入 Git、日志、错误、截图、E2E 输出或 `verification/`。`.env.example` 只列出变量名，不含值。

## Jellyfin 合同

`src/jellyfin/jellyfin-adapter.ts` 是独立 REST adapter，Jellyfin 特殊逻辑不进入通用 `DesktopSpiderSession`。它覆盖：

- 公开系统信息与 token 用户认证；
- 媒体库；
- 电影与剧集列表；
- 季与单集列表；
- 搜索与详情；
- `PlaybackInfo` 中的 Direct Play 选择。

Direct Play URL 必须保持在配置的 Jellyfin server origin；URL 中的 `api_key` 会被移除，token 只作为受控请求头保留。只有转码 URL 时返回 `JELLYFIN_TRANSCODING_UNSUPPORTED`，不伪造 Direct Play。

## 播放桥接

`src/jellyfin/jellyfin-playback.ts` 是 Jellyfin 专用播放桥：

```text
JellyfinAdapter.getPlayback
→ PlaybackProxyServer（X-Emby-Token 只在上游请求注入）
→ EmbeddedPlaybackController（parse=0、headers 为空的本地 URL）
→ 内嵌播放器
```

每个桥接 session 使用独立 LocalProxy token；切换或关闭时停止播放器、撤销代理 session 并释放端口。公开 playback state 只保留脱敏后的媒体元数据和本地 Proxy URL，不回传 Jellyfin token。适配器没有实现复杂服务端转码控制。

## 本地合同 fixture

`tests/jellyfin-adapter.test.ts` 启动 loopback HTTP fixture，覆盖系统信息、认证、媒体库、电影、剧集、季、集、搜索、详情、Direct Play、受保护媒体、LocalProxy 和转码能力错误。fixture 是协议测试数据，不是第三方 Jellyfin 实例。

可选真实 E2E 只有三个环境变量同时存在时才运行；缺少变量时测试明确记录 `external-environment-blocked`，本地合同测试仍必须通过。

## 验证命令

```powershell
npm run typecheck
npm test
npm run electron:e2e:package
```

## 非目标

不接入来源不明 TVBox 接口，不绕过认证或 DRM，不把 fixture 当真实 Jellyfin，不提交 token，不实现复杂转码控制。
