# G71 包内 mpv 与 aria2

状态：完成。依赖：G70。

## 决策

mpv 和 aria2 的默认 executable 从 `electron-runtime` 相对路径解析。显式 `QX_MPV_PATH`、`QX_ARIA2_PATH` 仍可用于开发/受控覆盖；没有显式覆盖时不扫描用户目录作为发布默认。

aria2 只监听 `127.0.0.1`，每个 backend 使用随机高端口和 32-byte RPC secret。进程通过参数数组启动，`shell=false`，启动后先完成有限时长的 `aria2.getVersion` readiness handshake，再接受下载请求。关闭时发送 `aria2.shutdown`，并保留已有进程退出清理。

## 真实 smoke

`npm run mpv:smoke` 使用包内 mpv 与本地媒体 fixture 建立 IPC，执行 load/play/pause/destroy；本次通过。

`npm run aria2:smoke` 使用包内 aria2 与本地媒体 fixture 完成真实 HTTP 下载，并验证目标文件非空；本次通过，下载 1546 bytes。

测试仍覆盖 executable 解析优先级、参数数组、shell 禁用、secret 不泄露和进程退出清理。G71 不声称提供第三方影视源发现、DRM 解密或 Android DEX 兼容。
## Size report

Measured Windows x64 bundled media runtimes:

| Component | Bytes |
| --- | ---: |
| mpv | 120,205,564 |
| aria2 | 5,754,502 |
| mpv + aria2 | 125,960,066 |
