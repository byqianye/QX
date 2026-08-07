# G67 Web 控制台设计

## 方向

Web 控制台是一个轻量、本地优先的控制面，不复制 Electron renderer，也不把
Electron IPC 或桌面 UI server 的所有路由转成 HTTP。它只消费显式的
`WebControlBackend` 白名单能力。

## 监听与边界

- `WebControlService` 独立监听 `127.0.0.1`，默认使用随机端口；不绑定
  `0.0.0.0` 或 `::`。
- G67 不提供局域网控制、端口映射、PIN 或 session 鉴权；页面明确显示
  `Requires G68 LAN Control`。
- HTTP API 不接受 SQL、文件路径、shell 命令、Spider 参数、信任策略、原始
  SQLite、原始进程、秘密值或诊断堆栈。
- 写请求必须带同源 `Origin` 和服务生成的 `X-CSRF-Token`。服务不会返回
  `Access-Control-Allow-Origin: *`。
- body 有硬限制，JSON 必须是对象；路由只接受登记的字段和有限长度/数值范围。

## API 页面

| 页面 | 读取 | 写入 |
| --- | --- | --- |
| 正在播放 | `/api/now-playing` | `/api/play`、`/api/pause`、`/api/stop`、`/api/seek`、`/api/volume` |
| 搜索 | `/api/search?q=`、`/api/detail?id=` | `/api/play-episode` |
| 直播 | `/api/live-channels` | `/api/live-channel` |
| 下载 | `/api/downloads` | — |
| 投屏 | `/api/cast-devices` | `/api/cast` |
| 安全状态 | `/api/safe-status` | — |
| Push | — | `/api/push` |

播放、直播和投屏只接收 opaque id；媒体 URL、请求头和 DLNA LOCATION 留在主
进程适配层，不进入 Web 响应。

## G68 security extension

G67 remains localhost-first. G68 adds an explicit `Allow LAN Control` switch,
private-interface binding, PIN login, expiring/revocable sessions, and separate
`read`/`control`/`push` permissions. LAN requests require the matching session;
loopback remains the local management boundary. See `docs/spike-68-web-security.md`.

## WebSocket

`/ws` 只接受同源 WebSocket 握手。连接数量、单帧大小和空闲时间均有限制；连接
收到初始安全快照，之后按固定间隔广播正在播放、直播、下载、投屏和安全状态。
服务关闭时主动结束所有连接。

## UI

页面使用本地 HTML/CSS/JavaScript 资源和严格 CSP，响应式适配手机、平板和桌面。
页面只有六个明确区域：正在播放、搜索、直播、下载、投屏、安全状态；用户输入
通过 `textContent`/白名单字段渲染，不把详情原始对象插回 DOM。
