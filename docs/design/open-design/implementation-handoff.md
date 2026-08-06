# QX 实现交接

## Binding constraints

- Electron + Vue 3 + TypeScript；renderer 不直接访问凭据、文件系统或第三方服务。
- 组件只引用 Neutral Modern 语义 token；禁止 raw hex、渐变、外部图片 CDN 和 emoji 功能图标。
- 侧栏 232/248px、顶栏 64px、桌面 gutter 24px；必须验证 1280、1440、1920 三种尺寸。
- 必须实现 hover、active、selected、disabled、focus、loading、error、warning、success、playing，并通过文字/图标补充颜色语义。
- 优先实现简报中的 18 个组件，不另建通用设计框架。

## 服务适配边界

```ts
type PlaybackResult = {
  protocol: "mp4" | "hls";
  requiresProxy: boolean;
  sourceRef: string;
  status: "ready" | "proxy-required" | "unavailable";
  diagnosticSteps: DiagnosticStep[];
};
```

API、Proxy、Spider、Jellyfin 由服务层适配到统一领域模型；LocalProxy 由 Electron main/preload 管理。`MediaCard`、`EmbeddedPlayer`、`ErrorState` 不拼接 URL、不发网络请求、不持有 secret。

## 首个 artifact 验收

- 1280×720：来源切换 → 搜索/筛选 → 详情 → 信任确认 → 线路选择。
- 1440×900：MP4/HLS 线路、播放器控制、分集选择和诊断摘要清晰可用。
- 1920×1080：内容最大宽度受控、网格扩展、抽屉不拉宽、播放器比例稳定。
- `Proxy Required` 可启用代理并重试；`Playback Unavailable` 可换线路；鉴权失效可进入设置。
- Tab / Enter / Escape / 方向键路径可达；无水平滚动、重叠、裸 token、未脱敏 URL 或虚构素材。

## 本次落地

正式 UI 入口为 `renderer/src/SpiderView.vue`，公共结构拆为 18 个局部组件；`Icon.vue` 提供本地 `currentColor` SVG 图标。G25 的 API envelope、错误码、PlaybackSelector、EmbeddedPlayer 和 Electron IPC 边界保持不变。未生成或引入远程素材。

## 已记录的最小冲突调整

校正后的 Open Design handoff 记录“仓库没有既有 SVG 资产时不现场发明图标”。G26 同时要求正式 UI 使用本地化功能图标且禁止 CDN；仓库没有可复用图标目录，因此只增加了一个不含品牌素材的 `Icon.vue`，以 `currentColor` 内联 SVG 提供必要导航/搜索图标。它不改变业务合同、主色或布局，也不引入外部资源。
