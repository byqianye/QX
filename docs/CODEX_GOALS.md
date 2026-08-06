# CODEX GOALS

## 项目阶段

- Stage 0：Spike 0–19 ✅ 已完成
- Stage 1：G20–G78 🚧 进行中

---

## G20（进行中）

### 目标
建立 Codex 目标模式工程治理体系

### 状态
进行中

### 依赖
无

### 范围
- AGENTS.md
- CODEX_GOALS.md
- 基线测试识别
- 文档对齐

### 验收标准
- AGENTS.md 完整
- CODEX_GOALS.md 完整
- Spike 0–19 状态正确记录
- 不修改业务逻辑

### 验证命令
```bash
npm run typecheck
npm test
npm run electron:e2e
```

## G21（已完成）

### 目标
将 Spike 19 的 `playerContent` 结果交给 Electron 内嵌 MP4/HLS 播放器。

### 状态
已完成。播放器与 JVM 结果边界已建立；带 headers 的结果由 G22 受控 LocalProxy 接管，`csp_Douban` 保持 `PLAYBACK_UNAVAILABLE`。

### 验证
- `npm run typecheck`
- `npm test`
- `npm run electron:e2e:package`

### 文档
- `docs/spike-20-embedded-player.md`

## G22（已完成）

### 目标
为需要受保护请求头的 MP4/HLS 播放源增加受控 LocalProxy，并在 Electron 内嵌播放器中完成 protected HLS 播放。

### 状态
已完成。代理仅监听 `127.0.0.1` 随机端口；会话令牌绑定 origin、请求头和生命周期；playlist 子资源全部重写；SSRF、请求头、大小、超时、并发和生命周期边界均已验证。

### 依赖
- G21 / Spike 20 内嵌 MP4/HLS 播放器
- Spike 19 `playerContent` headers 结果

### 验收标准
- 无 headers 的 MP4/HLS 继续直连内嵌播放
- 带 `Referer`/`User-Agent` 的 protected HLS 只能通过随机本地代理播放
- renderer 不能通过任意 query 指定上游 URL
- 代理拒绝不安全协议、私网地址、跨 origin redirect 和禁用请求头
- 切换、关闭、过期和 Electron 退出会撤销代理会话、终止上游请求并释放资源

### 验证命令
```powershell
npm run typecheck
npm test
npm run electron:e2e:package
```

### 文档
- `docs/spike-21-local-proxy.md`

## G23（已完成）

### 目标
将详情页的 CatVod 线路与选集协议接入同一个 Spider Session、`playerContent`、G22 LocalProxy 和 Electron 内嵌播放器，完成受控点播闭环。

### 状态
已完成。JVM-native fixture 已覆盖导入后的首页、分类、搜索、详情、线路、选集和播放路径；线路/选集解析、顺序切换、失败恢复和播放资源生命周期均有测试，未接入第三方影视源。

### 依赖
- G21 / Spike 20 内嵌 MP4/HLS 播放器
- G22 / Spike 21 受控 LocalProxy

### 验收标准
- `vod_play_from` 与 `vod_play_url` 按 `$$$`、`#`、第一个未编码 `$` 解析
- 支持多线路、多集、空线路、缺失集名、重复集名和 Unicode/编码 URL
- 无法区分未编码保留字符时返回 `PLAYBACK_FORMAT_INVALID`
- UI 正确传递 `flag`、真实播放 `id` 和 `vipFlags`
- 切集/切线路停止旧播放器并释放旧 LocalProxy，不重启 Spider Session
- 播放失败保留详情、线路、选集并支持重试/切线路
- 开发版和打包版受控点播闭环通过验证，sidecar、fixture、端口和播放 token 无泄漏

### 验证命令
```powershell
npm run typecheck
npm test
npm run electron:e2e:package
```

### 文档
- `docs/spike-22-vod-playback-e2e.md`

## G24（已完成）

### 目标
接入独立、授权的 Jellyfin REST 媒体源，并把 Direct Play 资源安全地接入 LocalProxy 与 Electron 内嵌播放器。

### 状态
本地适配器、协议合同 fixture、播放桥接和普通 Electron 打包验证已完成。当前未提供完整 Jellyfin 环境变量，真实服务器验证为 `external-environment-blocked`，不宣称真实环境已验证。

### 依赖
- G23 / 受控 VOD 播放闭环
- Spike 23 / 授权 Jellyfin 媒体源

### 范围与验收标准
- 读取并校验 `QX_JELLYFIN_URL`、`QX_JELLYFIN_TOKEN`、`QX_JELLYFIN_USER_ID`，拒绝不安全 URL、部分配置和凭据泄露
- 独立 `JellyfinAdapter` 覆盖连接、认证、媒体库、电影、剧集、季、集、搜索和详情
- 仅选择真实 Direct Play；转码-only 或无 Direct Play 时返回明确能力错误，不伪造播放地址
- 通过受控 LocalProxy 注入 `X-Emby-Token`，向内嵌播放器暴露本地无凭据 URL，并在切换/关闭时释放播放资源
- 本地 loopback fixture 合同测试稳定通过；可选真实 E2E 仅在三项环境变量齐全时运行
- 不接入来源不明接口，不绕过认证或 DRM，不实现复杂服务端转码控制

### 验证命令
```powershell
npm run typecheck
npx vitest run tests/jellyfin-adapter.test.ts
npm test
npm run electron:e2e:package
```

### 文档
- `docs/spike-23-jellyfin-source.md`

## G25（已完成）

### 目标
将现有桌面 UI 迁移到本地打包的 Vue 3 + Vite + TypeScript renderer，同时保持既有 Spider、Session、LocalProxy、播放器 API 和错误码。

### 状态
Vue renderer 已接入 Electron 正式包；旧 server-rendered UI 保留为回退路径和回归基线。类型检查、Vue 专项测试、全量测试和两轮打包 E2E 已通过。

### 依赖
- G23 / 受控 VOD 播放闭环
- G24 / Jellyfin source 可独立存在，真实环境验证不阻塞本 Goal

### 范围与验收标准
- 建立本地 Vue 3/Vite 工程，构建产物进入 Electron 正式包，不加载远程脚本
- 建立类型化 `ImportState`、`SpiderState`、`BrowseState`、`DetailState`、`PlaybackState`、`ErrorState`
- 迁移配置导入、信任确认、站点选择、首页、分类、搜索、详情、线路、选集、播放器和错误状态
- 保持既有 `/api/*` 调用、Spider/Session/LocalProxy/播放器合同和错误码；受保护播放继续经 LocalProxy
- 设置合理 CSP，保留旧 renderer，待 Vue E2E 通过后再考虑停用
- 不接入直播、弹幕、下载、复杂 UI 库、视觉大改或新媒体源

### 验证命令
```powershell
npm run typecheck
npx vitest run tests/vue-renderer.test.ts
npm test
npm run electron:e2e:package
```

### 文档
- `docs/spike-24-vue-renderer.md`

## G26（blocked_open_design_unavailable）

### 目标
使用可直接调用的 Open Design 生成正式桌面 UI 设计，并按设计产物实现。

### 状态
已检查当前 Codex 环境的 Open Design MCP 能力。工具声明存在，但 `get_active_context`、`list_projects`、`list_agents`、`list_skills`、`list_plugins` 的实际调用均返回 `Transport closed`，因此 Open Design 不可用。未生成设计方向、设计系统、截图或 implementation handoff；G25 Vue UI 保持可用。

### 依赖
- G25 / Vue renderer 迁移
- 当前环境可用的 Open Design MCP transport

### 阻塞处理
- 标记：`blocked_open_design_unavailable`
- 不用普通 AI 或自行 CSS 替代 Open Design
- 不继续 G27–G29
- Open Design transport 恢复后，从 G26-A 重新检查并生成唯一最终设计方向

### 文档
- `docs/spike-25-open-design-desktop-ui.md`

G27–G78（未开始）

（略，按主路线图执行）

DEX-1 ~ DEX-5（实验支线）

- DEX-1：Android Emulator 探针
- DEX-2：DEX Spider 加载验证
- DEX-3：Electron RPC 通信
- DEX-4：资源评估
- DEX-5：是否产品化决策

---

## 基线命令（Baseline Commands）

项目当前识别的标准验证命令：

```bash
npm run typecheck
npm test
npm run electron:e2e
```

说明：

- `electron:e2e` 可能在 `package.json` 中名称略有差异；
- 当前 `package.json` 中对应的实际打包 E2E 命令为 `npm run electron:e2e:package`；
- 以实际 `scripts` 为准。
