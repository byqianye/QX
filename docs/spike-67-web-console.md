# Spike 67：本地 Web 控制台

## Goal 状态

- 状态：complete
- 依赖：G66 `checkpoint: complete G66 DLNA cast`
- checkpoint：`checkpoint: complete G67 web console`

## 实现范围

G67 新增独立的 `WebControlService` 和 `WebControlBackend` 适配层：

- 只监听 `127.0.0.1`，默认随机端口；主进程在 Electron shell 启动后启动，
  在数据层关闭时关闭。
- 提供 now-playing、播放控制、搜索、详情、选集、直播频道、Push、下载状态、
  DLNA 设备/投屏和 safe-status 白名单接口。
- HTTP 路由契约公开 method/path/schema/permission/rate class；没有任意 SQL、
  文件路径、命令、Spider 执行、信任策略、原始进程或秘密接口。
- GET 读取接口按本地 Origin 检查，所有 POST 强制同源 Origin 和 CSRF token；
  body、JSON、字段、数值和请求频率有稳定限制。
- `/ws` 使用手写的最小 WebSocket 握手/帧处理，只广播安全状态，并限制连接数、
  单帧大小和空闲时间。
- HTML、CSS、JavaScript 都由本地服务提供，页面包含正在播放、搜索、直播、下载、
  投屏和安全状态区域；不复制完整 Electron renderer，不使用 CDN。
- `DesktopSpiderUiServer.webControlBackend()` 只映射已有主进程服务的安全投影：
  标题、opaque id、播放进度、能力和状态；不把 URL、Cookie、Referer、绝对路径、
  DLNA LOCATION 或堆栈放入 Web 响应。

## 明确不属于 G67

- 不开放 LAN 监听、自动端口映射、PIN/session 鉴权；这些属于 G68。
- 不新增第三方媒体源、解析能力、任意文件播放或任意 Electron IPC 代理。

## 验收标准

1. 服务只能绑定 `127.0.0.1`，随机/配置端口都可启动并在关闭后释放。
2. 16 条最小 API 路由和 WebSocket 安全快照有稳定测试；非法 JSON、超大 body、
   额外字段、外部 Origin、缺失/错误 CSRF 都被拒绝。
3. 响应和 Web UI 不泄露绝对路径、原始媒体地址、请求头、token、SQLite/进程/堆栈。
4. 播放、暂停、停止、seek、volume、搜索、详情、选集、直播、Push、下载状态和
   投屏均通过显式 backend 方法执行。
5. 本地响应式页面使用严格 CSP；WebSocket 验证初始状态、连接上限、超大帧和关闭清理。
6. Electron typecheck、核心测试、renderer build、Electron build/package 和
   packaged first/restart E2E 通过。

## 验证命令

```powershell
git diff --check
npx tsc --noEmit --pretty false
npx vitest run tests/web-control.test.ts tests/desktop-ui.test.ts tests/cast-service.test.ts --maxWorkers=1 --minWorkers=1
npm test -- --maxWorkers=1 --minWorkers=1 --reporter=dot
npm run renderer:build
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
```
