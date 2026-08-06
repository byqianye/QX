# G45 mpv 播放后端

## 状态

已完成。G45 只交付开发环境可注入的播放后端合同和 mpv 集成；随包 mpv 留到 G71。现有嵌入式页面仍按 HTML video → hls.js 的浏览器路径运行，不会把所有流默认切到 mpv。

## PlayerBackend 合同

`src/desktop/player-backend.ts` 建立统一 `PlayerBackend`：

- `load`、`play`、`pause`、`stop`、`seek`
- `volume`、`mute`
- `currentTime`、`duration`、`state`、`error`
- `destroy`

实现为：

1. `HtmlVideoBackend`：直接媒体使用 HTML media element；浏览器原生支持 HLS 时也优先使用它。
2. `HlsJsBackend`：仅在 URL 是 m3u8、原生 HLS 不可用且注入的 hls.js factory 报告可用时创建实例。
3. `MpvBackend`：前两者不能处理时才作为 fallback。

`PlayerBackendChain` 按传入顺序执行上述选择。headered source 不会被任一 backend 当作可直接播放地址；它必须先经过 G43 LocalProxy，mpv 只接收无 header 的 proxy URL。

## mpv 路径与进程

路径解析顺序固定为：

1. 用户设置 `mpvPath`
2. `QX_MPV_PATH`
3. 开发机受控路径探测（Windows 的 Program Files/LocalAppData，Unix 的 `/usr/bin/mpv` 和 `/usr/local/bin/mpv`）

显式路径必须存在；缺失统一返回 `MPV_UNAVAILABLE`。不会自动下载、安装或修改 PATH。真实 smoke 只有在显式提供 `QX_MPV_PATH` 和 `QX_MPV_SMOKE_URL` 时才会运行；否则 `npm run mpv:smoke` 输出 `real_mpv_external_environment_blocked` 并成功退出。

每个 `MpvBackend` 实例生成唯一 IPC endpoint，使用明确 executable、参数数组、`shell=false`、隐藏 stdio 和独立 JSON IPC。命令参数不携带 Cookie、Authorization、Referer 等 header；关闭时先发送 `quit`，超时后通过 Windows `taskkill /T /F` 或平台等价方式结束进程树。进程崩溃、IPC 错误、无响应和超时分别保留稳定诊断码，不把原始 header 或 stderr 写入普通日志。

## 测试与限制

`tests/player-backend.test.ts` 使用 fake-mpv 覆盖：参数数组、shell 选项、IPC 命令、单 Session 单进程、状态控制、崩溃、超时、无响应、正常退出、强制结束、LocalProxy header 边界和后端顺序。真实 mpv 不作为合同测试依赖；无外部 mpv 时标记 `real_mpv_external_environment_blocked`。

G45 不打包第三方 mpv，不实现字幕、流健康回退或调试面板，也不引入未授权媒体源。后续目标可以在这个合同上接入调试事件、字幕和回退策略。
