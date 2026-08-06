# Spike 21：受控 LocalProxy 播放代理

## 状态

G22 已完成。代理只为当前播放会话创建受控资源，不提供任意上游转发能力。

## 目标与边界

Spike 20 的内嵌播放器不能直接携带 `Referer`、`User-Agent`、`Cookie` 或 `Authorization` 等上游请求头。G22 在 Electron 主进程中增加独立的 `PlaybackProxyServer`，仅监听 `127.0.0.1` 的随机端口，把已验证的 `parse=0` HTTP(S) 播放源转换为带随机令牌的本地资源 URL。

本目标不实现 `parse=1`、MPV/VLC 迁移、真实第三方影视源接入，也不把代理暴露到 `0.0.0.0` 或公网。

## 会话与资源模型

- 每次带请求头的播放创建一个独立会话。
- 会话令牌使用高熵随机值，并绑定初始 URL 的 origin、允许转发的请求头、创建时间和过期时间。
- 初始媒体和 playlist 中发现的子 playlist、segment、`EXT-X-KEY`、`EXT-X-MAP` 都映射为会话内随机资源 ID。
- 代理路径只接受令牌和已登记资源 ID；拒绝 query 参数，因此 renderer 不能通过 query 指定任意上游 URL。
- playlist 中所有相对或绝对的 URI 都被重写为同一会话的受控 URL。playlist 根资源保留 `.m3u8` 后缀，使内嵌播放器选择本地 hls.js。

## 请求头策略

代理会注入会话允许的 `User-Agent`、`Referer`、`Origin`、`Cookie`、`Authorization`，并支持显式的常见请求头（如 `Accept`、`Accept-Language`、`Cache-Control`、`Pragma` 和 `X-Requested-With`）。

`Host`、`Connection`、`Content-Length`、`Transfer-Encoding`、`Upgrade`、`Proxy-*` 及其他 hop-by-hop 头会被拒绝；CR/LF 也会被拒绝。上游响应只保留播放所需的内容类型、长度、Range、缓存和校验相关响应头，代理错误体限制在固定大小内，日志路径不记录令牌或敏感请求头。

## SSRF 防护

- 只接受 `http:` 和 `https:`，拒绝 `file:`、`ftp:`、`data:` 和带 URL 凭据的地址。
- 初始 URL、playlist 子资源和每一跳 redirect 都必须保持会话 origin；跨 origin redirect 被拒绝。
- 非显式允许的 origin 会进行 DNS 解析并拒绝 loopback、私网、链路本地、保留地址、IPv4-mapped IPv6 私网地址和本地域名。
- `QX_PLAYBACK_PROXY_ORIGINS` 只用于明确授权的本地 fixture/媒体 origin；Electron 启动时不会接受 renderer 传入 allowlist。

## 资源限制与生命周期

代理分别限制连接、首字节和总请求时间，限制 playlist、错误体和媒体体大小，并限制单会话并发请求数。会话过期、切换来源、关闭 UI 或 Electron 退出时会撤销令牌、abort 上游请求、销毁播放器、关闭代理服务器并释放端口。

## 验证

`src/electron/media-fixture.ts` 的 protected HLS 要求精确的 `Referer` 和 `User-Agent`，否则返回 403。单元测试覆盖 URI 重写、headers、Range、redirect、SSRF、令牌过期/撤销、大小/超时/并发限制；打包 Electron E2E 验证 protected playlist、init/segment 经代理实际进入 hls.js，并验证 MP4/HLS、重启和 sidecar 退出。

验证命令：

```powershell
npm run typecheck
npm test
npm run electron:e2e:package
```
