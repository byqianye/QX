# Spike 56：直播源导入

## Goal 状态

- 状态：已完成
- 依赖：G50 SQLite 数据层、G54 Cache 边界、G55 portable data mode、既有 Open Design 桌面壳
- checkpoint：`checkpoint: complete G56 live source import`

## 范围

G56 只建立直播源的安全导入、预览、确认、持久化、刷新和设置管理能力：

- M3U/M3U8 与 TXT（`频道,URL`、`频道,URL1#URL2`、`分组,#genre#`）解析；支持 BOM、CRLF/LF、Unicode、中文长名称、常见 M3U 属性、相对地址（必须显式提供 base）。
- SQLite v4 的 `live_sources`、`live_channels`、`live_channel_streams` 表及事务替换。
- URL 仅允许 HTTP(S)，限制重定向同源、超时、响应大小和内容类型；支持 ETag/Last-Modified 以及 last-known-good 频道保留。
- 设置页中的 URL/文件预览、确认导入、刷新、启停、移除和导入诊断。
- 本地文件的原始内容只在当前进程的预览/刷新期间保留；数据库保留已确认频道，重启后需要重新选择本地文件才能刷新。

## 数据与安全边界

- Repository → LiveSourceService → Desktop UI API → Vue renderer；renderer 不读取 SQLite、文件系统或网络响应。
- 原始播放 URL、请求头和 raw playlist 不进入 renderer 预览状态；UI 只接收来源摘要、频道名、统计和脱敏诊断。
- 拒绝 URL 内嵌账号/密码以及 token、Cookie、authorization、api-key 等敏感查询认证；M3U 条目中的敏感播放地址被跳过并生成诊断。
- 不实现频道播放、EPG、节目单、自动切源、DRM 绕过、第三方真实影视源发现或 Android DEX 兼容。

## 验收标准

- 同一来源的预览不会写数据库；只有确认导入才以事务方式替换频道与线路。
- 同名但 URL 不同的条目不被错误合并；同一频道可保留多条线路。
- 远程刷新失败保留已保存频道，并在来源上记录脱敏错误；304 使用已保存版本。
- 重启恢复来源、频道、启停状态；源地址与数据库内容不包含测试凭据。
- 单元、UI API、renderer build、Electron build、打包 first/restart E2E 通过，Electron/sidecar 退出后无残留进程。

## 验证命令

```powershell
npm run typecheck
npx vitest run tests/live-source.test.ts tests/live-ui.test.ts tests/sqlite-data-layer.test.ts
npm test
npm run renderer:build
npm run electron:build
npm run electron:e2e:package
git diff --check
```

## 后续明确不属于 G56

G57 负责频道目录与选择；G58 负责 EPG；G59 负责健康检查与切源；G60 负责启动/定时刷新；G61 负责完整验收收口。本 Goal 不提前实现这些能力。
