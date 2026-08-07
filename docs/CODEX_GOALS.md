# CODEX GOALS

## 项目阶段

- Stage 0：Spike 0–19 ✅ 已完成
- Stage 1：G20–G78 目标模式进行中
- 当前子阶段 Stage 3：数据与用户功能阶段 ✅ 已完成

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

## G49（已完成）

### 目标

完成播放增强综合验收，建立完全本地 fixture，覆盖 parse=1、解析回退、Referer、LocalProxy、主/子 m3u8、Rules、sniff 回退、字幕、线路回退、调试时间线和关闭清理。

### 状态

已完成。packaged E2E 首次启动与重启均通过；所有媒体、解析器、Douban 兼容接口和 fake-mpv 均为本地受控 fixture。线路回退使用有界候选和总超时，并在显式回退尝试前清除来源健康冷却，避免健康熔断挡住已授权的备用线路。

阶段更新：阶段 2：播放增强闭环完成。

### 验收范围

- 导入、信任、多站点、聚合搜索、详情、线路、选集；
- parse=1、第一解析器失败/第二解析器成功、sniff 备用路径；
- Referer、LocalProxy、Rules、字幕、HLS 主/子清单；
- 第一线路失败、第二线路成功、独立窗口、调试面板和错误恢复；
- 无外部浏览器、无后台播放器、sidecar/Proxy/sniff/fake-mpv 清理。

### 安全边界

parse 和 Proxy 都不是开放代理；sniff 不提供 Node、文件系统或共享 Cookie；mpv 使用 `shell: false`；字幕不把文本作为 HTML 注入；Rules 绑定来源/会话/路径；回退有最大尝试次数、去重和总超时。

### 验证结果

- `npm run typecheck`：通过；
- `npm test`：43 个测试文件、237 个测试通过；
- `npm run electron:build`：通过，使用既有 development-fallback JDK；
- `npm run electron:e2e:package`：首次启动和重启均通过，解析回退、sniff 回退、线路回退、Rules、字幕、聚合搜索、fake-mpv 和资源清理均为 true；
- 真实 mpv smoke：仍受外部 `QX_MPV_PATH` 环境控制，本 Goal 只验证 fake-mpv 合同，不宣称 mpv 随包；
- 未 push。

### 文档

- `docs/spike-49-playback-enhancement-acceptance.md`

### checkpoint

```text
checkpoint: complete G49 playback enhancement acceptance
```

## G50（已完成）

### 目标

建立正式 SQLite 数据层、schema migration、主进程 repository 边界、旧 JSON 一次性迁移和安全恢复路径，作为 G51—G55 的数据基础。

### 状态

已完成。采用 Node `node:sqlite` `DatabaseSync`（运行时要求 Node `>=22.5.0`），开发版和 Windows x64 packaged app 均可加载。桌面状态与配置历史已切换到 SQLite；旧 desktop state、config history、可选 source/stream health JSON 通过 transaction 和 `data_migrations` 标记迁移，缺失文件不提前标记，失败保留原文件。数据库损坏、高版本、迁移失败和写入失败均映射为脱敏稳定错误码；恢复库路径稳定，可在重启后复用；敏感配置字段不会原样进入 SQLite；播放进度 writer 已提供 debounce、interval 和关闭/暂停/停止/换集 flush seam。

### 依赖

- G49 播放增强综合验收

### 范围

- `src/data/`：普通模式数据目录、`node:sqlite`、schema migration、recovery、repositories、进度写入和旧数据迁移；
- `src/electron/main.ts`：主进程初始化、SQLite 配置历史/桌面状态接入和 close 生命周期；
- Renderer 继续只接收类型化 API/state，不直接访问 SQLite；
- `docs/spike-50-sqlite-data-layer.md` 与 G50 专项测试。

### 验收结果

- G50 专项、迁移 rollback、DB lock（含 transaction 起始锁）、corrupt DB、too-new DB、prepared statement、Renderer 数据边界、repository CRUD、旧数据迁移与 handle close 测试通过；
- `npm run typecheck`：通过；
- `npm test`：通过；
- `npm run electron:build`：通过；
- `npm run electron:package:win`：通过；
- `npm run electron:e2e:package`：首次启动与重启均通过，SQLite 状态从 packaged DB 恢复；
- 未 push；G51—G55 尚未在本 Goal 中实现。

### 文档

- `docs/spike-50-sqlite-data-layer.md`

### checkpoint

```text
checkpoint: complete G50 SQLite data layer
```

## G51（进行中）

### 目标

建立来源/内容/集数稳定身份的播放历史与进度闭环，接入 SQLite、Electron 播放生命周期、明确恢复交互、正式 History 页面和隐私控制。

### 状态

已完成。G51 核心服务、播放 Controller 接线、History API、Vue History 页面和专项测试已实现；全量回归、Windows packaged first/restart E2E、resume/privacy/lifecycle 验证均通过。

### 依赖

- G50 SQLite 数据层与 `PlaybackProgressWriter`
- G26 Open Design 桌面 UI 合同

### 范围

- `src/history/`：稳定身份、完成规则、resume candidate、脱敏 DTO、进度服务；
- `src/desktop/spider-ui.ts`：播放成功、同步、暂停/停止/换集/关闭 flush，以及 History API；
- `src/electron/main.ts`：共享 History service 与 DB close 生命周期；
- `renderer/src/HistoryView.vue`、History 路由和恢复确认交互；
- `tests/history-progress.test.ts`、桌面 UI/Renderer 回归与 G51 文档。

### 验收标准

- 同标题不同来源不互相覆盖；不以标题作为身份；跨线路按 episode ID 匹配；
- 起播成功后才创建记录，进度 debounce，pause/stop/换集/窗口关闭/app exit flush；
- 完成阈值明确且有测试；已完成记录的从头/继续策略明确；恢复不静默 seek；
- History 页面支持最近、继续、已完成、搜索、排序、来源、单删、批删、清空和确认；
- 默认保留历史，可暂停记录；SQLite 中无临时播放 URL、Proxy token、Cookie、Authorization；
- 全量测试、typecheck、build、Windows package、packaged first/restart E2E 和 sidecar/resource 清理通过。

### 验证命令

```powershell
npm run typecheck
npx vitest run tests/history-progress.test.ts tests/desktop-ui.test.ts tests/vue-renderer.test.ts
npm test
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
```

### 文档

- `docs/spike-51-history-progress.md`
- `docs/design/open-design/data-features/history-page-spec.md`
- `docs/design/open-design/data-features/design-extension.md`
- `docs/design/open-design/data-features/page-specs.md`
- `docs/design/open-design/data-features/component-specs.md`
- `docs/design/open-design/data-features/interaction-specs.md`

### checkpoint

```text
checkpoint: complete G51 history and progress
```

## G52（已完成）

### 目标

建立来源/内容身份稳定的收藏闭环：SQLite 持久化收藏与分组，提供收藏/取消收藏、分组管理、排序、搜索、详情页状态和源不可用提示，并接入 Electron 主进程、正式 Favorites 页面与 packaged E2E。

### 状态

已完成。收藏服务、schema v2 迁移、分组与排序 transaction、Favorites 页面、详情按钮、来源不可用提示、重启持久化和 packaged E2E 均已验证；审查发现的问题已修复。

### 依赖

- G50 SQLite 数据层与 repository 边界
- G51 稳定 source/vod 身份、History 页面与 Open Design 数据特性规范
- Electron 主进程生命周期和现有 Renderer API envelope

### 范围

- 收藏主键为 `sourceId + vodId`；相同标题但不同 source 独立保存；不保存临时播放 URL、Proxy token、Cookie 或 Authorization。
- 默认分组与自定义分组：创建、改名、排序、移动；删除非空分组必须明确选择移入默认分组或删除其中收藏，默认分组不可删除。
- 手动排序、收藏时间、标题、最近观看排序；手动排序通过 SQLite transaction 写入。
- Sidebar 正式 Favorites 路由；Grid/List、分组侧栏、搜索、来源标记、移动、上下移、详情、取消收藏；详情页显示收藏/已收藏并支持移动分组。
- 当前来源不可用时保留收藏，明确显示不可用，并允许删除或按标题搜索其他来源；不自动替换来源。

### 验收标准

- `tests/favorites.test.ts` 覆盖重复收藏、取消、同标题不同源、分组生命周期、非空分组删除决策、事务排序、最近观看排序、源不可用、隐私和重启持久化。
- `tests/vue-renderer.test.ts` 覆盖正式 Favorites 页面、分组/收藏操作事件、Sidebar 路由和详情页收藏控件。
- `tests/electron-e2e.test.ts` 与 packaged E2E 覆盖收藏写入、分组移动、详情打开、重启保留和 SQLite 隐私行审计。
- SQLite schema migration、主进程服务生命周期、Renderer 数据边界和现有全量回归保持通过。

### 验证命令

```powershell
npm run typecheck
npx vitest run tests/favorites.test.ts tests/vue-renderer.test.ts tests/electron-e2e.test.ts
npm test
npm run renderer:build
npm run electron:build
npm run electron:e2e:package
```

### 文档

- `docs/spike-52-favorites.md`
- `docs/design/open-design/data-features/favorites-extension.md`
- `docs/design/open-design/data-features/favorites-page-spec.md`

### checkpoint

```text
checkpoint: complete G52 favorites
```

## G53（已完成）

### 目标

建立基于来源/内容身份的追更闭环：SQLite 持久化追更状态、复用现有 detail 能力检查更新、同步播放历史中的已看集数，并在 Open Design 桌面壳中提供应用内更新提示。

### 状态

已完成。追更服务、schema v3 poster 迁移、来源串行/全局并发限制、历史同步、Follow 页面、详情页加入追更/收藏并追更、应用内 badge、重启持久化和 packaged E2E 均已实现；不包含 Windows Toast、后台 Service 或云推送。

### 依赖

- G52 SQLite 收藏与来源/内容身份边界
- G51 播放历史与进度同步
- G41 Source Health/circuit-breaker 合同
- G26 Open Design 桌面 UI 与 G52 数据特性扩展

### 范围

- `src/follow/`：FollowService、稳定身份、详情 episode 提取、更新判定、并发检查、历史已看同步和脱敏状态。
- `src/data/`：`follow_items.poster` 的 schema v3 additive migration 与 repository 映射。
- `src/desktop/spider-ui.ts`、`src/electron/main.ts`：Follow API、当前来源约束、现有 detail/health 路径和服务生命周期。
- `renderer/src/FollowView.vue`、Sidebar、DetailDrawer、state/persistence 接线。
- G53 专项、Renderer、desktop API、Electron E2E、packaged privacy audit 与设计文档。

### 验收标准

- 加入/取消追更、收藏并追更、重启恢复和 source/vod 去重通过；普通收藏不会自动成为追更。
- 稳定 episode ID 优先、名称其次，ordered episode list 作为 episode 来源；不得只比较总集数。
- 用户打开追更页或手动刷新才触发检查；单来源失败记录错误且不阻塞其他来源；并发受限并复用现有 detail/source health 能力。
- 已看状态从 G51 history 同步；标记已看/未看不删除原始 history；Follow 页面显示更新、已追平、检查中、来源失败、最后检查、最新集和已看集，并支持更新优先/最近/标题排序。
- 仅提供应用内 badge；不实现 Windows Toast、后台服务或云推送。
- typecheck、定向测试、全量测试、Renderer/Electron build 和 packaged first/restart E2E 通过，且无遗留 QX/Electron/Java 进程。

### 验证命令

```powershell
npm run typecheck
npx vitest run tests/follow.test.ts tests/vue-renderer.test.ts tests/electron-e2e.test.ts
npm test
npm run renderer:build
npm run electron:build
npm run electron:e2e:package
```

### 文档

- `docs/spike-53-follow-updates.md`
- `docs/design/open-design/data-features/follow-page-spec.md`

### checkpoint

```text
checkpoint: complete G53 follow updates
```

## G54（已完成）

### 目标

正式管理非敏感、可再生缓存，并把容量、过期、LRU、安全路径和 Settings
Storage / Cache UI 接入同一套 CacheService。

### 范围

- poster、backdrop、source config、home/category、search、detail、subtitle、EPG
  placeholder、parser metadata、temporary。
- 统一 hash + metadata cache key；文件只允许位于 cache root，拒绝 traversal 与
  symlink/junction escape。
- 独立 TTL、expired-first + LRU 容量清理、in-use lease 保护、图片 MIME/签名/大小
  校验、下载失败 placeholder、并发重复请求去重。
- Cache UI 只清理可再生缓存，不触碰 history、favorites、follow、settings 或数据库。
- Authorization、Cookie、LocalProxy token、临时媒体 URL、sniff private state 和
  mpv IPC 不进入缓存。

### 验收与验证

- `tests/cache.test.ts` 覆盖 put/get、TTL、expired、LRU、size、duplicate、traversal、
  MIME、download failure、concurrent、category/all clear、restart、用户数据保护和
  symlink 安全。
- `tests/desktop-ui.test.ts`、`tests/vue-renderer.test.ts` 覆盖 API 与 Settings UI。
- `tests/electron-e2e.test.ts` 与 packaged E2E 覆盖缓存状态 API、清理和 packaged cache
  root / user database 保留。
- `docs/spike-54-cache-management.md` 记录设计边界与风险。

### 状态

已完成。缓存元数据复用 SQLite `cache_entries`，用户数据不随缓存清理删除。

### 检查点

```text
checkpoint: complete G54 cache management
```

## G55（已完成）

### 目标

正式实现 normal / portable data mode，统一 DataRoot、Database、Cache、Logs、Temp、
Backups、Settings 路径，并提供用户确认的安全迁移。

### 范围

- packaged `QX影视.exe` 同目录存在 `data/` 才进入 portable；开发环境即使源码目录
  存在 `data/` 也保持 normal。
- 启动时统一创建目录并检查 DataRoot、Cache 可写；portable 失败返回
  `PORTABLE_DATA_NOT_WRITABLE`，提供 normal / 其他目录 / 退出选择。
- 迁移使用临时目录、SQLite integrity check、目标旧数据 `backups/mode-switch-*`，
  成功后才切换；portable 返回 normal 时旧 `data/` 改名保留，不自动删除。
- Settings 增加 Storage / Portable 状态、脱敏 Data Root、数据库/缓存/总大小、打开
  目录和确认切换；Electron 使用单实例锁，第二实例只聚焦已有窗口。

### 验收与验证

- `tests/data-directory.test.ts` 覆盖 normal、portable、开发环境、可写性、数据库/缓存
  迁移、回切、备份、失败保留、完整性校验和数据目录结构。
- `tests/desktop-ui.test.ts`、`tests/vue-renderer.test.ts` 覆盖 Storage API/UI 与确认。
- `tests/electron-e2e.test.ts`、packaged E2E 覆盖脱敏 storage state、restart、cache root、
  database 保留与进程清理。
- `docs/spike-55-portable-data.md` 记录 Resolver、迁移原子性边界、备份和非目标。

### 状态

已完成。业务数据只通过 DataDirectoryResolver/DataStorageService 解析，切换需要重启
以避免旧 SQLite handle 继续写入。

### 检查点

```text
checkpoint: complete G55 portable data mode
```

## G56（已完成）

### 目标

建立直播源的安全导入、预览、确认、SQLite 持久化、手动刷新和来源管理能力，支持 M3U/M3U8/TXT URL 与本地文件，并保留刷新失败时的 last-known-good 频道。

### 状态

已完成。schema v4 增加直播源/频道/线路表；LiveSourceService 通过预览→确认事务替换写入；Desktop UI API、renderer 直播源管理页、重启持久化和 packaged first/restart E2E 已接通。频道播放、EPG、自动切源、DRM 和 Android DEX 仍按计划留给后续 Goal。

### 范围

- `src/live/`：M3U/TXT parser、来源导入/刷新/启停/移除服务及 safe UI state。
- `src/data/`：SQLite v4 migration、LiveRepository 和频道线路映射。
- `src/desktop/spider-ui.ts`、`src/electron/main.ts`：typed live API、服务生命周期和错误边界。
- `renderer/src/LiveSourcesView.vue`、Sidebar、state、persistence 和现有 Open Design token 接线。
- live source 单元、UI API、SQLite migration、renderer build、packaged E2E、restart 和 privacy audit。

### 验收与验证

- URL/file 预览不写库；确认后事务替换频道/线路；同名不同 URL 不误合并，同频道多线路保留。
- HTTP(S) 约束、同源重定向、超时、大小/content-type 校验、ETag/304、last-known-good、敏感认证拒绝通过。
- renderer 不接触 SQLite、文件系统、raw playlist、播放 URL 或 headers；数据库不包含测试凭据。
- `npm run typecheck`、定向/全量 Vitest、renderer/Electron build 和 packaged first/restart E2E 通过，且 Electron/sidecar 退出后无残留进程。

### 文档

- `docs/spike-56-live-source-import.md`
- `docs/design/open-design/live-tv/`

### checkpoint

```text
checkpoint: complete G56 live source import
```

## G57（已完成）

### 目标

在 G56 的来源与线路数据之上建立直播频道目录、单频道播放、手动线路选择、最近频道
和可取消的单会话生命周期，并复用现有 PlayerBackend、EmbeddedPlayer 与 LocalProxy。

### 状态

已完成。schema v5 增加 `live_recent`；LivePlaybackService 使用 generation +
AbortController 防止快速切换的旧请求覆盖新会话；受保护线路通过 LocalProxy 播放；
目录、窗口化频道列表、键盘选择、线路按钮、最近频道和播放器状态已接入 Open Design
页面。节目单、健康评分、自动切源、DRM 和 Android DEX 仍未实现。

### 范围与验收

- 支持启用来源中的分组/频道目录、手动线路选择和最近播放持久化；停用、移除、刷新
  会停止失效来源的当前会话。
- HTTP(S) HLS/媒体线路按现有后端边界播放；带 headers 的线路必须经 LocalProxy，
  proxy session 在切换/停止/退出时撤销。
- `LIVE_*` 稳定错误码覆盖来源、频道、协议、起播失败、超时和切换取消；播放器状态
  不暴露认证 headers。
- fixture A/B/C/D/E 覆盖直连、受保护 HLS、500、延迟失败和双线路切换；定向、全量、
  renderer、Electron、打包 first/restart E2E 与进程清理通过。

### 文档与验证

- `docs/spike-57-live-playback.md`
- `docs/design/open-design/live-tv/live-browser-spec.md`
- `tests/live-playback.test.ts`
- `tests/live-playback-ui.test.ts`

验证命令：

```powershell
npm run typecheck
npm test
npm run renderer:build
npm run electron:build
npm run electron:e2e:package
git diff --check
```

### checkpoint

```text
checkpoint: complete G57 live playback
```

## G58（已完成）

### 目标

在 G57 的直播数据与 UI API 之上建立 XMLTV EPG 来源、流式解析、SQLite 持久化、刷新与设置管理能力。

### 状态

已完成。G58 的 parser、schema v6、批量事务写入、retention、ETag/304、last-known-good、EPG Settings API/renderer、媒体 fixture 和 packaged first/restart E2E 均已通过验证。

### 依赖

- G57 checkpoint `c4a4828`：`checkpoint: complete G57 live playback`

### 范围与验收

- 支持 `xmltv-url`、`xmltv-file`、`fixture`；SAX 流式解析 channel/programme/title/sub-title/desc/category/icon。
- 禁止 DTD/external entity/XXE；限制压缩前、解压后、文本、频道、节目与请求时间；错误归类为 `EPG_PARSE_FAILED`、`EPG_SOURCE_FAILED`、`EPG_TOO_LARGE`、`EPG_XML_UNSAFE`。
- XMLTV 时间统一为 UTC；缺少时区按明确文档政策解释为 UTC；SQLite v6 增加 `epg_sources`、`epg_channels`、`epg_programmes` 及窗口查询索引。
- 预览不写库；确认使用 prepared statement + 单事务替换一个来源；保留当前/未来节目，清理过期节目；刷新支持 ETag/Last-Modified/304 和 last-known-good。
- Settings 提供 URL/file 添加、预览、确认、启停、刷新、删除、计数、最近成功和错误状态；renderer 不接触 SQLite、raw XML 或请求头。
- 定向/全量测试、renderer/Electron build、Windows 打包、packaged first/restart E2E 和进程清理通过。

### 文档与验证

- `docs/spike-58-xmltv-epg.md`
- `docs/design/open-design/live-tv/epg-settings-spec.md`
- `tests/epg.test.ts`
- `tests/epg-ui.test.ts`
- `tests/media-fixture.test.ts`

### checkpoint

```text
checkpoint: complete G58 XMLTV EPG
```

## G59（已完成）

### 目标

在 G58 XMLTV 数据层之上建立确定性的 Live Channel → EPG Channel 匹配、
用户确认映射、Alias/Call Sign 和有界节目时间线。

### 状态

实现、目标测试、完整回归、Windows 打包和 packaged first/restart E2E 均已通过。
G59 checkpoint 已创建；未 push。

### 依赖

- G58 checkpoint `7628f96`：`checkpoint: complete G58 XMLTV EPG`

### 范围与验收

- 严格按 explicit mapping → tvg-id → normalized name → alias/call sign 匹配。
- exact/high 可默认映射；medium 只显示建议；low、冲突和多候选不随机选择。
- `userConfirmed=true` 映射优先且自动匹配不得覆盖；支持 SQLite 持久化、重启和有效源刷新保留。
- Live 页面显示当前/下一节目与时间线；时间线窗口和条目数量在 service 层有界。
- 复用 Open Design Neutral Modern token、现有 Settings/Live Channel 组件，不引入 TV Launcher 风格。

### 文档与验证

- `docs/spike-59-epg-matching.md`
- `docs/design/open-design/live-tv/epg-mapping-timeline-spec.md`
- `tests/epg-matching.test.ts`
- `tests/epg.test.ts`
- `tests/electron-e2e.test.ts`
- `tests/media-fixture.test.ts`

### checkpoint

```text
checkpoint: complete G59 EPG matching
```

## G60 (completed)

### Goal

Build user-controlled Smart Channels over the G59 live catalog and EPG mapping layer: persistent multi-source membership, suggestions, deterministic health/priority selection, manual source switching, explicit/inherited EPG, source lifecycle resilience, renderer management UI, and packaged first/restart E2E coverage.

### Status

Completed. Schema v8, repository/service/API/renderer integration, tests, builds, and packaged first/restart E2E passed. Runtime health scores are an explicit seam for deterministic selection; real network probing remains out of scope.

### Dependency

- G59 checkpoint `8bfce23`: `checkpoint: complete G59 EPG matching`

### Scope and acceptance

- Smart Channel rows and members persist transactionally in SQLite.
- Suggestions require exact tvg-id, normalized name, or shared EPG evidence and require user confirmation.
- Selection respects manual choice, preferred member, known health score, priority, and stable tie-breaks.
- Disabled/deleted sources do not delete the Smart Channel; remaining members continue to work.
- Explicit EPG wins; inherited EPG uses only the preferred member; conflicts are not guessed.
- Live UI exposes Sources/Smart Channels tabs and management actions.
- Renderer, service/API, restart, and packaged first/restart E2E checks pass.

### Verification commands

```powershell
npm run typecheck
npm test
npm run renderer:build
npm run electron:build
npm run electron:e2e:package
git diff --check
```

### Checkpoint

```text
checkpoint: complete G60 smart channels
```

## G61 (completed)

### Goal

Add explainable, finite, cancellable Live health failover over G60 Smart
Channels: stream metrics and score, batched persistence, Off/Ask/Auto modes,
ordinary line failover, Smart Channel member failover, cooldown, manual
override, EPG continuity, redacted debug UI, deterministic fixture coverage,
and Stage 4 verification.

### Status

Completed. Health summaries are aggregated and debounced into the existing
`stream_health` table. Failover uses tried candidates, attempt/deadline limits,
generation cancellation, `AbortController`, temporary cooldown, and a default
`Ask` mode. Packaged first/restart E2E covers line failover, Smart member
failover, startup failure, EPG continuity, debug state, restart hydration, and
process cleanup.

### Dependency

- G60 checkpoint `9232c13`: `checkpoint: complete G60 smart channels`

### Scope and acceptance

- Health metrics return `unknown` with no samples and expose explainable score
  reasons; pause, seek, stop, exit, and manual line changes are not failures.
- Only defined startup, repeated playlist/segment, fatal, disconnect, and long
  buffer triggers may start failover; one segment or short buffer cannot switch.
- Ordinary channels and Smart Channels use deterministic finite candidates with
  loop prevention, cooldown/recovery, maximum attempts, total timeout, and
  manual override expiry.
- Switching preserves Smart Channel identity and EPG timeline identity while
  updating only playback source/line/health.
- Health/debug UI is typed and redacted; high-frequency events do not write one
  SQLite row per segment.
- Unit, renderer, build, package, first/restart E2E, security, performance,
  migration, and process-cleanup evidence is recorded under `verification/`.

### Verification commands

```powershell
git diff --check
npm run typecheck
npm test
npm run renderer:build
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
```

### Documentation

- `docs/spike-61-live-failover.md`
- `docs/design/open-design/live-tv/live-failover-spec.md`

### Checkpoint

```text
checkpoint: complete G61 live failover
```

## Stage 4 (completed)

直播与 EPG 闭环已完成：授权 M3U/TXT 导入、Live 浏览与播放、XMLTV、EPG
四层匹配与 Timeline、Smart Channel、多线路、健康评分、有限自动故障转移
以及本地 packaged first/restart E2E。外部 IPTV/Jellyfin 服务、DRM、真实
第三方源能力和 Android DEX 不在本阶段承诺内。

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
