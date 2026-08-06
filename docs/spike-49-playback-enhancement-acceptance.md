# Spike 49：播放增强综合验收

## 状态

已完成。G49 在 G42—G48 的基础上，用完全本地的媒体、解析器、Douban 兼容接口和 JVM Spider fixture，覆盖首次启动与重启后的播放增强闭环。

## 依赖与范围

- 依赖 G42—G48：解析链、Playback Rules、隔离 sniff、播放器后端、调试面板、字幕轨道和流健康回退。
- 只使用 `127.0.0.1` fixture，不访问真实影视站或未经授权的第三方解析服务。
- 只验证受控的 HTTP(S) 媒体地址、LocalProxy、HLS 主/子清单、字幕和 fake-mpv 合同。

## 本地 fixture 拓扑

| 场景 | fixture 行为 | 验收点 |
| --- | --- | --- |
| 普通播放 | MP4、HLS、带 Referer 的受保护 HLS | 播放、Proxy、Referer |
| HLS 拓扑 | `/media/master.m3u8` 指向 `/media/fixture.m3u8` | 主/子 m3u8、MAP、segment |
| 解析链 | 第一候选返回 503，第二候选返回本地 HLS | parse=1、解析回退 |
| sniff 回退 | parser 候选均失败，隔离页面发现延迟 m3u8 | sniff→LocalProxy |
| 线路回退 | `fallback-fail` 返回 503，`fallback-good` 返回 HLS | 有界重试、第二线路恢复 |
| 字幕 | VTT、SRT、ASS fixture | 轨道 Proxy、编码和无 XSS |
| 聚合搜索 | 两个本地 Douban 兼容站点返回同一条目 | 多站点聚合、详情 |
| mpv | fake-mpv IPC 返回 success 并在 quit 后退出 | 退出、IPC 清理、无强杀 |

## packaged E2E 验收

首次启动和信任状态重启均覆盖：导入、信任、多站点、聚合搜索、详情、线路/选集、parse=1、解析回退、Rules、Proxy、sniff、字幕、线路回退、独立窗口、调试面板、错误恢复、无外部浏览器、无后台播放器，以及 sidecar、Proxy、sniff session 和 fake-mpv 清理。

线路回退只在显式的有界回退流程中重置来源健康冷却状态；回退协调器仍负责候选去重、最大尝试次数和总超时，因此不会形成无限循环。

sniff 输入和输出都经过安全 header 白名单；原始 Spider header 不会直接注入 Proxy。sniff 使用独立 Electron partition、`contextIsolation`、`sandbox`、`webSecurity`，并关闭 Node integration、下载、弹窗和跨 origin 导航。

## 安全边界

- parse 链只允许 HTTP(S) 和显式 allowlist origin，不是开放代理。
- LocalProxy 绑定 loopback，并校验 origin、地址、header、响应大小和超时，不是开放代理。
- sniff 不提供 Node、文件系统或主页面 Cookie；诊断只保留脱敏字段。
- mpv 使用 `shell: false`，fake-mpv 仅为测试替身，不随包提供真实 mpv。
- 字幕只接受受控的 HTTP(S) 轨道或用户选择的本地文件；渲染文本不走 HTML 注入。
- Rules 绑定 source/session/path，不跨来源套用。
- 日志和持久化状态不写入凭据、Cookie、token 或完整敏感地址。

## 不宣称的能力

- mpv 未随应用打包；真实 mpv 仍需用户配置且受 smoke gate 约束。
- 未支持 DRM。
- 未宣称兼容所有第三方解析器。
- sniff 不是任意网页抓取器，只处理受控 allowlist 和有界资源。
- 未宣称完整 ASS 特效兼容。

## 结果

- `npm run typecheck`：通过。
- `npm test`：43 个测试文件、237 个测试通过。
- `npm run electron:build`：通过，使用既有 development-fallback JDK。
- `npm run electron:e2e:package`：首次启动和重启均通过。
- E2E 结束后检查项目进程、sidecar、fixture、Proxy、sniff WebContents 和 fake-mpv：均应为零残留。

## checkpoint

```text
checkpoint: complete G49 playback enhancement acceptance
```
