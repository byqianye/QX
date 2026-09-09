# G124：深色影院 UI 与播放器改版

## 状态

`完成（本地代码与 Tauri 窗口范围）`。本 Goal 只处理渲染器视觉、观看页布局、播放器控件收纳、默认来源和加载状态表达；不更换播放引擎或源协议。

## 依赖与范围

- 保留已有工作区改动；实施前快照保存在 `tmp/cinema-ui-baseline/`。
- 默认来源固定为 `http://xn--z7x900a.net/`，只在 Tauri 桌面首次且没有已保存配置时自动导入并确认；测试专用 preset 优先级保持不变。
- 新用户默认深色主题（深灰/暖金色），已有 `light`/`system` 选择继续有效。
- 首页改为内容优先的影院列表；HTTP 警告折叠；真实海报按原比例显示。
- 观看页采用宽屏左视频右选集，小于 1200px 自动改为上下布局；来源、线路、选集集中到侧栏。
- 播放速度和字幕设置收进播放器“更多”菜单；播放详情和诊断折叠；续播提示仍要求明确选择。
- 加载中、失败和空列表使用不同状态，不显示假进度。

## 修改文件

- `renderer/src/styles.css`
- `renderer/src/pages/BrowsePage.vue`
- `renderer/src/pages/WatchPage.vue`
- `renderer/src/PlaybackSelector.vue`
- `renderer/src/PlaybackHealthPanel.vue`
- `renderer/src/PlayerControls.vue`
- `renderer/src/EmbeddedPlayer.vue`
- `renderer/src/MediaGrid.vue`
- `renderer/src/App.vue`
- `renderer/src/ConfigImportView.vue`
- `renderer/src/CoreShell.vue`
- `renderer/src/SpiderView.vue`
- `renderer/src/tauri-renderer-api.ts`
- `src/desktop/state-persistence.ts`
- `renderer/src/default-source.ts`
- `tests/cinema-ui.test.ts`及相关主题/路由回归断言

## 验证结果

- `npm run typecheck`：通过。
- `npm run renderer:build`：通过。
- 目标测试：3 个文件、58 项通过。
- 完整 Vitest：101 个文件、613 项通过；1 项失败来自本机 AdGuard 改写 HTTP 响应的 `style-src 'unsafe-inline'` CSP 断言，非本次代码变更。改动前基线同样失败。
- `git diff --check`：通过。
- Tauri CDP 窗口：使用默认地址自动导入，来源自动选择为默认配置中的“荐片”；首页在 1024、1440、1920 宽度均完成截图，真实海报加载正常；观看页截图显示左视频/右选集布局和独立滚动选集。
- 真实播放：本地 loopback 夹具被后端播放代理的私有/本地地址安全边界拒绝（`PLAYBACK_PROXY_INVALID`），因此没有将夹具失败宣称为播放成功。现有真实源播放证据未被改动。

截图证据：`artifacts/cinema-ui/real-source/`；改动前基线：`tmp/cinema-ui-baseline/screenshots/`。

## 未完成事项与风险

- 尚未完成加载速度 Goal：当前没有对配置下载、搜索、详情、解析和首帧建立正式耗时基线。
- 尚未完成新源接入效率 Goal：仍需把声明式转换器和专用适配器的验证入口统一化。
- 完整测试的 CSP 失败受本机网络过滤软件影响，需要在不改安全策略的干净环境复核。
- 真实 Tauri 播放仍需使用受控远程或既有 packaged fixture；本地 loopback 媒体不能绕过播放代理安全规则。
- 未自动 push、未打包发布。
