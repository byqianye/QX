# Spike 14：真实桌面 UI 接入

## 边界

当前工作区没有 Electron、Tauri 或其他现成桌面 UI 壳，因此本 Spike 采用 Node 内置 HTTP server + 无框架 HTML 页面作为最小真实 UI。它不是最终桌面产品壳，但页面、事件和调用生命周期是真实可运行的。

UI 层分为两部分：

- `DesktopSpiderUiController` 把 `DesktopSpiderSession` 转成页面可消费的 `state`，并管理导入确认、首页、分类、搜索、详情、切换和关闭。
- `DesktopSpiderUiServer` 提供页面和 JSON action endpoint；页面按钮通过 HTTP action 调用 controller，页面关闭/切换 action 会销毁当前 session 及 JVM sidecar。

## UI 行为

- 未信任来源首先显示导入警告和“确认并信任”按钮。
- 确认后允许启动 `csp_Douban`，再显示首页、分类、搜索和详情操作。
- 调用期间显示“加载中”；RPC 错误显示错误码；超时显示“请求超时”，并保留 `SPIDER_TIMEOUT` 诊断码。
- 详情页的播放按钮始终禁用，并显示“Douban：无正片播放源”。本 Spike 不增加 `playerContent`。
- “切换来源”和“关闭”都会调用 `destroy()`；切换在提供 session factory 时创建新 session。

## 验证

本地稳定测试：

```text
npx vitest run tests/desktop-ui.test.ts
```

覆盖首次确认、UI renderer、四个调用、加载状态、超时错误、HTTP action、切换和关闭销毁。

真实 Douban UI 验收：

```text
npm run spike:douban-desktop-ui
```

探针实际启动页面，通过 `/api/import/confirm`、`/api/open`、`/api/home`、`/api/category`、`/api/search`、`/api/detail` 和 `/api/close` 完成：

```text
确认 → 启动 → 首页 → 分类 → 搜索 → 详情 → 关闭
```

验收同时检查详情中的 `msearch:<id>`、播放禁用标记和 sidecar 已停止。
