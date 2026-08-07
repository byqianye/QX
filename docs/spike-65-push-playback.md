# Spike 65：push:// 与本机投送基础

## Goal 状态

- 状态：已完成
- 依赖：G64 `checkpoint: complete G64 download manager`
- checkpoint：`checkpoint: complete G65 push playback`

## 范围

G65 建立统一的 `PushRequest` 与 `PushService`，当前只开放本机回环地址：

- 支持 `url`、`source-item`、`local-file`、`live-channel`、`fixture` 五类 typed request。
- `push://` URI 必须先经过 parser 和 validation，不会因为看到 URI 就自动执行。
- Push endpoint 由主进程绑定 `127.0.0.1` 和随机/配置端口；非回环连接拒绝。
- 默认未知 Push 进入确认队列，Settings 提供 Ask、可信本机策略、端口、启用开关、最近记录清理。
- 冲突策略为 Replace、Queue、Reject，播放适配器只调用既有 `DesktopPlaybackSession` 或
  `LivePlaybackSession`，不创建第三套播放器状态。

## 安全边界

- 目标地址只允许 HTTP/HTTPS，拒绝 `file:`、`javascript:`、`data:`、`ftp:`、凭据和未信任的
  loopback/private/link-local DNS 结果。
- 可选 origin allowlist 与 trusted-local origin 用于明确授权的本机服务；默认不把本机网络视为可信。
  `Allow trusted local apps` 只对来自 allowlist Origin 的 localhost 请求生效，不能由请求体自行声明
  `trusted-local`；IPv4-mapped IPv6 私网地址也按私网地址拒绝。
- Push 请求头只允许 `Accept`、`Accept-Language`、`Origin`、`Referer`、`User-Agent`，拒绝
  `Host`、`Connection`、`Content-Length`、`Proxy-*`、`Authorization`、`Cookie` 和 CR/LF 注入。
- URL 进入桌面播放时强制经现有 LocalProxy；代理继续执行每次重定向的同源、DNS、私网和响应边界检查。
- Push 播放转换串行化；关闭服务会撤销待确认和排队请求，自然结束的播放会触发 Queue 消费。
- UI、最近记录、确认预览和错误不会回显完整 URL、凭据、请求头或本机路径。LAN 访问、PIN 和 session
  鉴权留到 G68。

## 验收标准

- localhost endpoint、URI parser、五类 request、非法 scheme、SSRF、redirect、header injection、
  confirmation、Replace/Queue/Reject、cancel、single playback session 和 shutdown 有稳定测试。
- Push 设置使用现有 SQLite `settings` 表持久化；服务关闭时释放 HTTP listener，队列和确认请求不启动后台播放器。
- Settings 页面显示 localhost endpoint、监听状态、确认队列、最近记录和 `Requires G68 LAN Control`。
- `npm run typecheck`、`npm test`、renderer/Electron build、Windows package 和 packaged first/restart
  E2E 通过。

## 明确不属于 G65

- 不绑定 `0.0.0.0`，不自动端口映射，不开放 LAN。
- 不自动发现或抓取第三方媒体源，不绕过认证、DRM、地区限制或付费权限。
- 不实现 DLNA、Web 控制台、LAN PIN/session；分别由 G66、G67、G68 完成。

## 验证命令

```powershell
git diff --check
npm run typecheck
npx vitest run tests/push-service.test.ts tests/desktop-ui.test.ts tests/vue-renderer.test.ts
npm test
npm run renderer:build
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
```
