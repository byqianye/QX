# Spike 24：Vue 3 Renderer 迁移

## 状态

G25 已完成。Electron 正式包优先加载 Vite 生成的 `dist/renderer`，两轮打包 E2E 均通过；旧的服务端 HTML renderer 保留在 `src/desktop/spider-import.ts`、`src/desktop/spider-ui.ts` 和 `src/desktop/embedded-player-ui.ts`，继续作为回退路径与回归测试基线。

## 运行结构

```text
BrowserWindow
    │ loadURL(local DesktopSpiderUiServer)
    ├─ dist/renderer/index.html + bundled Vue 3/Vite assets
    │       └─ /api/* JSON actions
    └─ DesktopSpiderUiServer
        └─ existing ImportController / UiController / Spider / LocalProxy / player contracts
```

`DesktopSpiderUiServer` 只新增静态产物服务和 CSP；Spider、Session、LocalProxy、播放器状态和错误码仍由原有 TypeScript 模块提供。未发现 renderer 产物时，server-rendered UI 继续提供旧路径。

## Renderer 工程

- `renderer/index.html` 是 Vite 入口；`renderer/src/` 使用 Vue 3 + TypeScript，不引入大型 UI 库或状态框架。
- `ImportState`、`SpiderState`、`BrowseState`、`DetailState`、`PlaybackState`、`ErrorState` 集中定义于 `renderer/src/state.ts`，通过 `/api/state` 和既有 action 响应更新。
- 组件覆盖配置导入、首次信任、站点选择、首页、分类、搜索、详情、线路、选集、播放器和错误状态。
- `hls.js` 从本地 npm 依赖打入 renderer bundle，播放器不加载远程脚本。

## 安全与打包

静态 renderer 响应设置：`default-src 'self'`、`script-src 'self'`、`style-src 'self'`、受限的媒体/连接 origin、`worker-src 'self' blob:`、`object-src 'none'` 和 `frame-ancestors 'none'`。静态路径限制在 renderer 根目录内，SPA 路由只回退到本地 `index.html`，`/assets/` 缺失资源不会回退成 HTML。

`npm run electron:build` 先运行 `npm run renderer:build`，再编译 Electron 主进程；正式包包含 `dist/renderer`。E2E 首次读取当前 Vue 页面，后续状态读取刷新窗口并等待 renderer ready，避免用静态 index 误判动态状态。

## 验证

```powershell
npm run typecheck
npx vitest run tests/vue-renderer.test.ts
npm test
npm run electron:e2e:package
```

专项测试覆盖类型化状态映射、静态产物服务、CSP 和本地资产；打包 E2E 覆盖导入、信任、站点切换、首页、分类、搜索、详情、线路、选集、MP4/HLS、LocalProxy、错误、重启和资源清理。

## 非目标与限制

- 不重写 Spider、Session、LocalProxy 或播放器合同。
- 不接入直播、弹幕、下载或新媒体源。
- G25 只完成可用的功能等价迁移；正式视觉方向留待 G26 Open Design。
- Vite 产物当前约 607 kB，构建会提示 chunk size warning；不影响功能验收，后续可在有明确需求时拆包。
