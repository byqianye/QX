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

## G26（complete）

### 目标
使用可直接调用的 Open Design 生成正式桌面 UI 设计，并按设计产物实现。

### 状态
Open Design transport 已实际可用。已用 UTF-8 简报成功启动校正后的正式 design run，生成唯一方向“安静的桌面工作台（quiet desktop workbench）”；5 位评审均无 MUST_FIX，最终 `ship_ready=true`、退出码 0。已按 handoff 实现 G26 正式桌面 UI，补齐长标题、超多选集和键盘焦点回归测试，完整测试、packaged E2E 和设计产物归档均已完成。

### 依赖
- G25 / Vue renderer 迁移
- 当前环境可用的 Open Design MCP transport

### 实现范围
- 归档 Open Design 的简报、token、页面/组件/交互规格和实现交接
- 实现正式 Vue 桌面壳层、搜索/来源/分类/筛选、媒体网格、详情抽屉、线路/选集、播放器控制、信任、错误恢复、设置和诊断组件
- 保留既有 API envelope、错误码、Spider、Proxy、播放器和 Jellyfin 边界
- 验证 1280×720、1440×900、1920×1080 的响应式布局规则及本地 SVG 图标

### 设计证据限制
Open Design 本次没有生成 HTML/SVG 原型，也没有可信截图；仓库在 `docs/design/open-design/screenshots/README.md` 明确记录为空，不以普通 AI 或伪造截图补足证据。

### 验收标准
- Open Design UTF-8 run 成功且内部审查无 MUST_FIX；设计产物完整归档。
- Vue UI 按唯一方向实现左侧导航、中央浏览、右侧详情、共存播放器、信任/加载/空/错误/设置/诊断状态。
- 支持系统/浅色/深色语义切换（默认浅色、不持久化），线路/选集、`Proxy Required`、`Playback Unavailable` 和本地资源均可验证。
- 组件级回归覆盖长标题、48 集选集、线路/分类 Tab 键盘移动与焦点调用；正式 UI 保留响应式最小窗口规则。
- 不修改 Spider、LocalProxy、播放器、Jellyfin、JVM sidecar 或配置解码协议；回归测试和 packaged E2E 通过。

### 验证命令
```text
npm run typecheck
npx vitest run tests/vue-renderer.test.ts --reporter=verbose
npm test
npm run renderer:build
npm run electron:e2e:package
```

### 阻塞处理
- G26 完成前不继续 G27–G29
- 真实 Jellyfin 鉴权/播放需要外部凭据，不能在本地验证时伪造成功

### 文档
- `docs/spike-25-open-design-desktop-ui.md`

## G27（已完成）

### 目标
继承 G26 Open Design Token，实现主题、窗口和页面状态的安全持久化与恢复。

### 状态
已完成安全 JSON 状态存储、原子替换、损坏备份、安全默认值、敏感字段拒绝、显示器工作区 bounds 修正、UI server 页面状态 API、renderer 主题/页面恢复和 Electron 窗口事件接入。专项测试、19 个测试文件/109 个测试、Electron 编译和修复后的 3 次 packaged E2E 均已通过；renderer 恢复探针等待请求稳定后再进入播放检查。

### 依赖
- G26 / Open Design UI checkpoint
- Electron `app.getPath("userData")`

### 实现范围
- `userData/desktop-state.json` 保存主题、窗口 bounds/最大化和非敏感页面元数据
- 临时文件 + rename 原子写入，损坏文件 `.corrupt-*.bak` 备份和脱敏诊断
- 显示器工作区检查、屏幕外窗口回主屏、尺寸下限和最大化恢复
- 导航、站点 key、分类、搜索、滚动位置、最近详情和主题在 UI server/renderer 间恢复
- 不保存 Proxy token、Authorization、Cookie、临时播放 URL 或 Jellyfin token

### 验收标准
- 默认浅色，支持浅色/深色/跟随系统；窗口宽高坐标和最大化状态可恢复
- 页面导航、站点 key、分类/搜索上下文、滚动位置和最近详情可恢复
- JSON 损坏不阻塞启动，使用安全默认值并备份损坏文件；写入失败不无限重试且诊断脱敏
- 移除显示器或越界坐标回到主显示器工作区；不把敏感字段写入状态文件
- 单元、集成、renderer、完整回归和打包 E2E 通过；sidecar/fixture/窗口资源无残留

### 验证结果
- `npx vitest run tests/desktop-state.test.ts tests/spider-import.test.ts tests/vue-renderer.test.ts`：23 tests passed
- `npm run typecheck`：通过
- `npm test`：19 files / 109 tests passed
- `npm run electron:e2e:package`：修复后连续 3 次通过；每次均包含 first/restarted 两轮，并验证持久化 JSON 合同和敏感字段未写入

### 验证命令
```powershell
npx vitest run tests/desktop-state.test.ts tests/spider-import.test.ts tests/vue-renderer.test.ts
npm run typecheck
npm test
npm run electron:e2e:package
```

### 文档
- `docs/spike-26-state-persistence.md`

### checkpoint
```text
checkpoint: complete G27 desktop state persistence
```

## G28（已完成）

### 目标
在同一个 Playback Session 内实现内嵌播放器与独立播放窗口的切换，始终只保留一个播放宿主、一个媒体源和一个 LocalProxy 会话。

### 状态
已完成。采用“销毁旧宿主、恢复同一逻辑 Session”的方案；主窗口先卸载 `<video>`，再创建子窗口，返回主窗口时先等待子窗口 `closed` 再恢复内嵌播放器。

### 依赖
- G27 / 页面与窗口状态持久化
- G26 / Open Design Token 与播放器控制规范

### 范围
- `DesktopPlaybackSession`、主窗口/子窗口宿主状态和 `/api/player/detach`、`/api/player/open`、`/api/player/attach`、`/api/player/sync`、`/api/player/stop`
- Electron 子窗口生命周期、主窗口关闭时的播放器/Proxy/sidecar 清理
- 播放进度、音量、静音、暂停状态、线路/选集和媒体源恢复；时间恢复误差目标不超过 2 秒
- 不做 PiP、系统媒体控制、第二播放器或无关窗口重构

### 验收标准
- 内嵌→独立→内嵌保持 Playback Session ID、媒体 URL、线路、选集和播放状态
- 切换不重复调用 `playerContent`，不产生第二个 Proxy token，不保留后台音频
- 子窗口支持播放、暂停、进度、音量、静音、全屏、当前线路/选集、返回主窗口和停止
- 子窗口关闭、停止播放和主窗口退出均释放对应资源
- 专项测试、完整测试、typecheck、Windows 打包和 packaged E2E 通过

### 验证结果
- `npx vitest run tests/detachable-player.test.ts tests/electron-e2e.test.ts tests/vue-renderer.test.ts tests/desktop-ui.test.ts tests/playback.test.ts`：5 files / 30 tests passed
- `npm run typecheck`：通过
- `npm test`：20 files / 112 tests passed
- `npm run electron:package:win`：通过
- `npm run electron:e2e:package`：first/restarted 两轮通过，播放器与资源清理检查全部通过

### 文档
- `docs/spike-27-detachable-player.md`

### checkpoint
```text
checkpoint: complete G28 detachable player
```

## G29（已完成）

### 目标
统一错误、诊断和恢复界面，保留原始错误码并以同一脱敏器提供可复制的安全诊断。

### 状态
已完成。renderer 建立 `AppError` 合同，覆盖配置、信任、Spider/RPC、播放/Proxy、HTMLVideoElement/HLS、Java、Electron、持久化和清理错误族；错误卡支持按 `retryable` 显示重试、返回、切换来源/线路、设置和复制诊断。

### 依赖
- G28 / 单 Playback Session 与播放器宿主切换
- G26 / Open Design 的 ErrorState、DiagnosticPanel 和 Token

### 范围
- `renderer/src/error.ts` 的错误码映射、恢复策略、诊断 ID、时间戳和统一脱敏
- `ErrorState`、`DiagnosticPanel`、配置导入错误、播放器媒体错误和复制诊断
- HTMLVideoElement/HLS 错误通过 `/api/player/sync` 保留原始错误码
- 不展示原始 stack、凭据、完整 URL、本机路径或敏感播放 ID

### 验收标准
- 主要错误族具有稳定标题、来源、原始 code、retryable 和安全诊断
- `retryable=false` 不显示无意义重试；可重试操作可再次执行，错误后应用仍可继续使用
- 复制诊断与界面使用同一脱敏器，敏感字段不会进入文本
- 专项测试、完整测试、typecheck、Windows 打包和 packaged E2E 通过

### 验证结果
- `npx vitest run tests/diagnostics.test.ts tests/playback.test.ts tests/detachable-player.test.ts tests/electron-e2e.test.ts tests/vue-renderer.test.ts`：5 files / 32 tests passed
- `npm run typecheck`：通过
- `npm test`：21 files / 126 tests passed
- `npm run electron:package:win`：通过
- `npm run electron:e2e:package`：first/restarted 两轮通过，错误界面、诊断复制入口、播放器、Proxy 和资源清理检查全部通过

### 文档
- `docs/spike-28-diagnostics.md`

### checkpoint
```text
checkpoint: complete G29 diagnostics
```

## G30—G41（已完成）

### 目标
建立统一 MediaSource 合同和多引擎基础，并完成来源信任、配置历史、站点管理、多站点 session、聚合搜索与健康治理。

### 状态
已完成。G30—G41 核心合同均已实现，恢复审计、专项测试、完整测试、Electron build、Windows package 和 packaged E2E 通过；恢复 checkpoint 已建立。JVM-native、QuickJS、Python 与 Jellyfin 的运行时边界保持明确，不宣称 Android DEX 通用兼容，也不提前随包分发 Python 或 mpv。

### 依赖
- G21—G29 Spider、LocalProxy、Playback Session、状态持久化和诊断基础

### 范围
- `src/source/` 统一 source contract、capabilities 和各引擎适配
- `src/spider/` JVM、QuickJS、Python sidecar 与 runtime 错误
- `src/engine/` Engine Router 和 Source Session Registry
- `src/config/` 内容哈希信任、版本历史、缓存、差异和刷新审查
- `src/desktop/` 来源路由、站点管理、导入、刷新和多站点 session seam
- `src/search/` 聚合搜索；`src/health/` 指标、熔断、冷却恢复和重试
- `src/jellyfin/` 专用 Jellyfin client 与 playback seam

### 验收标准
- G30—G41 每项核心合同有实现和稳定测试
- 引擎生命周期、并发 session 限制、退出清理和缺少 runtime 错误可验证
- 信任与 Spider 内容哈希绑定，配置危险变化不能静默执行，健康诊断脱敏
- `npm run typecheck`、`npm test`、Electron build、Windows package 和 packaged E2E 通过
- 不提交 verification、构建产物、缓存、环境文件或真实凭据；不提前实现 G42 以后功能

### 验证结果
- `tests/source-contract.test.ts`、`tests/jvm-engine.test.ts`、`tests/python-engine.test.ts`、`tests/quickjs-engine.test.ts`、`tests/engine-router.test.ts`、`tests/trust.test.ts`、`tests/config-history.test.ts`、`tests/config-refresh.test.ts`、`tests/site-management.test.ts`、`tests/aggregate-search.test.ts`、`tests/source-health.test.ts` 和 `tests/spider-import.test.ts`：通过
- `npm run typecheck`：通过
- `npm test`：31 files / 175 tests passed
- `npm run electron:build`：通过
- `npm run electron:package:win`：通过
- `npm run electron:e2e:package`：首次和重启轮次通过

### 文档
- `docs/spike-30-41-multi-engine-foundation.md`
- `verification/G30-G41-recovery/`（本地、被 `.gitignore` 忽略）

### checkpoint
```text
checkpoint: complete G30-G41 multi-engine foundation
```

## G42（已完成）

### 目标
实现 `playerContent` 返回 `parse=1` 时的受控解析链，并将最终媒体地址接入现有 LocalProxy 与内嵌播放器。

### 状态
已完成。解析候选按优先级执行，支持 JSON、redirect、显式 HTML media 字段、source-provided 和本地 fixture；超时、取消、循环、最大深度、最大响应、协议和 origin 边界均有测试。packaged E2E 首次启动与重启轮次均实际覆盖 parse=1。

### 依赖
- G21—G29 内嵌播放器、LocalProxy、Playback Session 与 AppError
- G30—G41 多引擎来源合同与生命周期基础

### 范围与验收标准
- `ParseRequest`、`ParseResult`、`ParserCandidate` 类型化并携带脱敏尝试诊断
- parse=0 不进入解析链；parse=1 按候选优先级回退，成功后停止后续尝试
- 请求只允许 HTTP/HTTPS 和显式 origin；redirect 重新校验；响应大小、超时、尝试次数和递归深度受限
- 解析失败、取消和关闭时清理请求；带 headers 的结果仍经现有 LocalProxy
- 不实现 G44 网页嗅探，不接入未授权第三方解析源，不把解析器变成开放代理

### 验证结果
- `tests/parse-chain.test.ts`、`tests/desktop-ui.test.ts`、`tests/electron-e2e.test.ts`：通过
- `npm run typecheck`：通过
- `npm test`：32 files / 182 tests passed
- `npm run electron:build`：通过
- `npm run electron:package:win`：通过
- `npm run electron:e2e:package`：首次和重启轮次通过；两轮 `parseChain` 均为 true

### 文档
- `docs/spike-42-parse-chain.md`

### checkpoint
```text
checkpoint: complete G42 parse chain
```

## G43（已完成）

### 目标
建立受控 Playback Rules 与 m3u8 安全处理层。

### 状态
已完成。规则按 source/session/path 作用域执行，支持 URL/header/query/host/path/URI/filter/marker action；处理后的清单保留 Key、Map、segment 和播放顺序，空清单返回 `PLAYBACK_RULE_INVALID`。packaged E2E 首启与重启均验证 protected fixture marker 经 LocalProxy 被移除。

### 依赖
- G42 parse=1 解析链
- G21—G23 LocalProxy、内嵌播放器与 Playback Session

### 验收标准
- 规则只作用于明确 source、session、origin 或 path，不拦截全局网络
- 相对 URI、主/子清单、segment、EXT-X-KEY、EXT-X-MAP、DISCONTINUITY 和明确 marker 可安全处理
- 规则冲突、命中、删除/保留数量可 dry run，差异脱敏
- 规则导致清单为空时拒绝结果，不把空清单传给播放器
- 不接入未授权来源，不把规则层变成开放代理

### 验证结果
- `tests/playback-rules.test.ts`、`tests/playback-proxy.test.ts`、`tests/electron-e2e.test.ts`：通过
- `npm run typecheck`：通过
- `npm run electron:e2e:package`：通过；首次和重启轮次 `playbackRules` 均为 true

### 文档
- `docs/spike-43-playback-rules.md`

### checkpoint
```text
checkpoint: complete G43 playback rules
```

## G44（已完成）
### 目标
在正常解析失败后，用临时 Electron partition 创建严格受控的隔离网页嗅探会话，只捕获可播放媒体请求，并将最终结果接回现有 LocalProxy seam。
### 状态
已完成。每次嗅探使用独立 `temp:qx-sniffer-*` partition 和隐藏 BrowserWindow，开启 `contextIsolation`、`sandbox`、`webSecurity`，关闭 `nodeIntegration`；不共享主页面 Cookie，不允许下载、弹窗或外部协议。候选按 MIME、扩展、状态、Content-Length、请求耗时、页面关联、master playlist 和可访问性评分，图片/CSS/JS/tracker/JSON/API 不会成为最终媒体。超时、取消和关闭均清理 session；parser 失败后的 UI fallback 与 packaged E2E 已闭环。
### 依赖
- G42 parse=1 解析链
- G43 Playback Rules 与 LocalProxy
### 范围
- `src/electron/isolated-sniffer.ts` 策略、候选评分、敏感 header 过滤与生命周期
- `src/electron/main.ts` 独立 partition/BrowserWindow/webRequest 适配
- `src/desktop/spider-ui.ts` parser failure 后的 sniffer fallback，并沿用 LocalProxy 接缝
- media fixture、UI/策略测试、打包 E2E 和进程/窗口清理验证
### 验证结果
- `tests/isolated-sniffer.test.ts`、`tests/desktop-ui.test.ts`、`tests/media-fixture.test.ts`、`tests/electron-e2e.test.ts`：通过
- `npm run typecheck`：通过
- `npm test`：34 files / 192 tests passed
- `npm run electron:build`：通过
- `npm run electron:package:win`：通过
- `npm run electron:e2e:package`：首次启动与重启轮次均通过，`isolatedSniffer=true`
### 验证命令
```powershell
npx vitest run tests/isolated-sniffer.test.ts tests/desktop-ui.test.ts tests/electron-e2e.test.ts
npm run typecheck
npm test
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
```
### 文档
- `docs/spike-44-isolated-sniffer.md`
### checkpoint
```text
checkpoint: complete G44 isolated sniffer
```

## G45（已完成）
### 目标
建立开发环境播放后端合同，实现 HTML video、hls.js 和 mpv fallback，并保证 mpv 不成为默认播放后端。
### 状态
已完成。`PlayerBackend` 统一 `load`、播放控制、时间/音量/静音、状态、错误和销毁；选择顺序固定为 HTMLVideo → hls.js → mpv。mpv 路径只来自用户设置、`QX_MPV_PATH` 或受控开发机探测，缺失返回 `MPV_UNAVAILABLE`，不会自动下载。
### 依赖
- G43 Playback Rules 与 LocalProxy
- G44 隔离网页嗅探
### 范围
- `src/desktop/player-backend.ts`：三个 backend、fallback chain、mpv JSON IPC、路径解析和进程树清理
- `src/electron/mpv-smoke.ts`、`package.json`：显式外部 mpv smoke gate
- `renderer/src/error.ts`：mpv 稳定错误码映射
- fake-mpv 合同测试与诊断测试
### 验证结果
- `tests/player-backend.test.ts`、`tests/diagnostics.test.ts`：通过；fake-mpv 覆盖参数、IPC、状态、崩溃、超时、无响应、正常退出和强制结束
- `npm test`：35 files / 207 tests passed
- `npm run typecheck`：通过
- `npm run electron:build`：通过
- `npm run electron:e2e:package`：首次启动与重启轮次均通过，既有 `isolatedSniffer`、`parseChain`、`playbackRules`、`sidecarStopped` 等检查保持通过
- `npm run mpv:smoke`：无 `QX_MPV_PATH` 时输出 `real_mpv_external_environment_blocked`
### 验证命令
```powershell
npx vitest run tests/player-backend.test.ts tests/diagnostics.test.ts
npm run typecheck
npm test
npm run electron:build
npm run electron:e2e:package
npm run mpv:smoke
```
### 文档
- `docs/spike-45-mpv-backend.md`
### checkpoint
```text
checkpoint: complete G45 mpv backend
```

## G46（已完成）
### 目标
建立播放调试面板和有限长度 `PlaybackEvent` 时间线，支持 D/设置/错误详情入口、脱敏复制与导出。
### 状态
已完成。普通键盘 D 可开关面板，输入框聚焦时不触发；面板展示 Source、Engine、Site、Playback Session、线路、剧集、playerContent、parse、Rules、sniff、LocalProxy、后端、起播时间、缓冲、错误、回退和 capability。时间线最多保留 200 条事件，JSON/文本导出不上传。
### 依赖
- G45 PlayerBackend 合同
### 范围
- `renderer/src/playback-debug.ts`：`PlaybackEvent`、状态推导、上限、脱敏和导出格式
- `renderer/src/PlaybackDebugPanel.vue`：面板、时间线、复制和本地导出
- `renderer/src/SpiderView.vue`、`DiagnosticPanel.vue`、`ErrorState.vue`、`AppErrorDetails.vue`：三种入口与键盘焦点保护
- `src/electron/e2e-runner.ts`、`src/electron/main.ts`：packaged UI 面板检查
- renderer/纯逻辑测试和 packaged E2E
### 验证结果
- `tests/playback-debug.test.ts`、`tests/playback-debug-ui.test.ts`、既有 `tests/vue-renderer.test.ts`：通过
- `npm test`：37 files / 212 tests passed
- `npm run typecheck`：通过
- `npm run electron:build`：通过
- `npm run electron:e2e:package`：首次启动与重启轮次均通过，`playbackDebug=true`，既有 parser/proxy/sniffer/player/lifecycle 检查保持通过
### 验证命令
```powershell
npx vitest run tests/playback-debug.test.ts tests/playback-debug-ui.test.ts tests/vue-renderer.test.ts
npm run typecheck
npm test
npm run electron:build
npm run electron:e2e:package
```
### 文档
- `docs/spike-46-playback-debug-panel.md`
### checkpoint
```text
checkpoint: complete G46 playback debug panel
```

## G47（已完成）
### 目标
接入安全字幕轨道，支持 WebVTT、SRT、基础 ASS/SSA 转换、多编码、远程 LocalProxy 和本地用户选择文件。
### 状态
已完成。`SubtitleTrack` 从 playerContent 进入统一播放 source；远程轨道逐条建立 LocalProxy session，renderer 只接收受控 URL；cue 文本转义后转换为原生 `<track>` 使用的 WebVTT。支持 Source、Jellyfin、local、local-proxy 和 fixture 标记，不接受来源提供的本机路径。
### 依赖
- G46 播放调试面板
- G43 LocalProxy
### 范围
- `src/subtitles.ts`：轨道合同、VTT/SRT/ASS/SSA、编码检测、时间轴校验、对象 URL 清理
- `src/desktop/spider-session.ts`、`src/desktop/playback.ts`、`src/desktop/spider-ui.ts`：playerContent 轨道接入和每轨道 Proxy 生命周期
- `renderer/src/SubtitleTrackPanel.vue`、`renderer/src/EmbeddedPlayer.vue`、`renderer/src/state.ts`：轨道选择、编码、字号、位置、背景、forced、本地文件
- `src/electron/media-fixture.ts`、`src/electron/e2e-runner.ts`：本地字幕 fixture 和 packaged E2E
### 验证结果
- `npm test`：39 个测试文件、221 个测试通过
- `npm run typecheck`：通过
- `npm run renderer:build`：通过
- `npm run electron:build`：通过（使用既有 development-fallback JDK）
- `npm run electron:e2e:package`：首次/重启均通过，`subtitleTracks=true`，项目进程清理通过
### 文档
- `docs/spike-47-subtitle-tracks.md`
### checkpoint
```text
checkpoint: complete G47 subtitle tracks
```

## G48（已完成）
### 目标
记录流健康指标，提供可解释评分和关闭/仅提示/自动三种线路回退模式。
### 状态
已完成。内存健康 registry 记录 resolve、首帧、起播失败、缓冲、致命错误、HTTP、分片、播放时长、完成、最近成功和连续失败；回退协调器执行重试、重新解析、同内容线路和更健康候选，并限制最大次数、尝试集合、总超时和用户取消。暂停、seek、单次短缓冲和短暂波动不会立即切线。
### 依赖
- G47 字幕轨道
- G46 播放调试时间线
- G43 LocalProxy、G42 解析链
### 范围
- `src/health/playback-health.ts`：指标、unknown、评分、候选排序、回退状态机和内存 registry
- `src/desktop/playback.ts`、`src/desktop/spider-ui.ts`：媒体事件、playerContent/parse/Proxy/播放器错误接入，回退 API 与生命周期
- `renderer/src/PlaybackHealthPanel.vue`、`renderer/src/EmbeddedPlayer.vue`、`renderer/src/playback-debug.ts`：健康 UI、事件采集、调试时间线
- `src/electron/e2e-runner.ts`、`src/electron/main.ts`：健康状态和 packaged E2E
### 验证结果
- `npm test`：42 个测试文件、233 个测试通过
- `npm run typecheck`：通过
- `npm run renderer:build`：通过
- `npm run electron:build`：通过（使用既有 development-fallback JDK）
- `npm run electron:e2e:package`：首次/重启均通过，`playbackHealth=true`
- E2E 后项目进程清理：`PROJECT_PROCESSES_PRESENT=false`
### 文档
- `docs/spike-48-stream-health-fallback.md`
### checkpoint
```text
checkpoint: complete G48 stream health fallback
```

## G49（未开始）

播放增强综合验收。

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
