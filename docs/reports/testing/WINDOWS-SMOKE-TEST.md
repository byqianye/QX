# QX影视 Windows x64 Smoke Test

测试日期：2026-08-08

测试范围：Windows x64、Electron 43.3.0、electron-builder 26.15.3、版本 0.1.0。

## 1. win-unpacked

执行文件：

`C:\Users\qiany\Documents\ChatGPT\QX影视\release\win-unpacked\QX影视.exe`

结果：PASS。`electron:e2e:unpacked` 完成首次启动和重启两轮，均返回 `status: passed`。

已通过的检查组：

- 应用启动、Vue renderer、首页和本地资源；
- 配置导入、来源切换、搜索、详情和受控媒体链；
- JS Spider Worker、JVM Spider sidecar、bundled runtime manifest；
- LocalProxy/PosterProxy、动态本地端口、HLS 拓扑和 proxy 清理；
- fake MPV exit、真实 bundled mpv smoke、播放窗口与播放器关闭；
- 用户数据、缓存、SQLite、收藏、历史、追更、备份和重启持久化；
- Web control、cast、EPG、live source、parser fallback 和 playback fallback；
- 首次/重启的 renderer 与后台资源清理；
- sidecar、Worker、proxy、播放器退出后无残留检查。

## 2. bundled runtime smoke

| Runtime | 结果 | 证据 |
| --- | --- | --- |
| CPython | PASS | `dist/electron-runtime/python/python.exe`，Python home/search fixture 通过 |
| mpv | PASS | `dist/electron-runtime/mpv/mpv.exe`，真实 load/play/pause/destroy smoke 通过 |
| aria2 | PASS | 真实 localhost JSON-RPC 下载 smoke 通过，下载 1546 bytes |
| JRE | PASS | packaged runtime manifest 完整性检查通过，unpacked E2E 使用包内 JRE |

## 3. NSIS 安装版

安装包：

`C:\Users\qiany\Documents\ChatGPT\QX影视\release\QX影视-Setup-0.1.0-x64.exe`

`electron:installer:e2e` 结果：PASS。

- per-user 安装成功；
- 安装目录中的 `QX影视.exe` 启动成功；
- 桌面快捷方式存在；
- 开始菜单快捷方式存在；
- 安装后 packaged E2E 通过；
- 卸载程序退出码为 0；
- 安装目录、快捷方式和测试临时产物清理成功；
- 默认不主动删除用户数据的 NSIS 行为保持不变。

## 4. Portable

Portable 包：

`C:\Users\qiany\Documents\ChatGPT\QX影视\release\QX影视-Portable-0.1.0-x64.exe`

测试方式：复制到与项目无关的 `C:\Temp\QXPortableTest-20260808\QX影视-Portable.exe`，不从项目目录启动，再执行完整 packaged E2E。测试完成后该临时目录已删除。

结果：PASS。Portable 首次启动与重启两轮通过，未依赖项目源码、`node_modules`、npm、VS Code 或开发机 cwd；Worker、bundled runtime、Proxy、缓存、用户数据和退出清理均通过。

## 5. 用户数据与路径

- 普通安装模式使用 `app.getPath("userData")`；
- 项目已有的 packaged `QX影视.exe` + sibling `data/` portable-data 规则保持不变；
- `resourcesPath`、renderer、runtime、cache、logs 通过 `RuntimePathResolver` 分开定位；
- 启动日志写入 user data 下的 `logs/qx-yingshi.log`，包含大小限制和轮转；
- 生产错误钩子记录 `uncaughtException` 与 `unhandledRejection`，敏感键值脱敏。

## 6. 未执行或不适用

- `npm run lint` 不适用：当前 `package.json` 没有 lint script；
- Windows 代码签名不在本 Goal 范围内，产物状态为 `SIGNED=false`；
- Android DEX runtime 不在当前项目实现范围内，不伪造该运行时或真实第三方源播放能力。
