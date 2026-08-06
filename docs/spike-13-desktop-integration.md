# Spike 13：真实桌面端 Spider 调用层

## 边界

当前工作区没有桌面 UI 框架，因此本 Spike 交付桌面 UI 可直接消费的会话和状态模型：

- `DesktopSpiderSession` 负责导入确认、配置选站、`DesktopSpiderClient` 路由、四个 Spider 调用和销毁；
- Spike 13 当前只接受 `csp_Douban`，避免把 Douban 的播放结论误用于其他 Spider；
- `DesktopSpiderView` 提供 `status/warning/error/sidecarRunning/playback`，渲染层不需要接触 sidecar 细节；
- `JsonFileTrustPersistence` 将用户明确确认的来源写入本地 JSON；
- Douban 播放状态固定为 `available: false`，UI 标签为“Douban：无正片播放源”。

## 导入信任流程

1. `inspectImport` 判断配置是否会执行 Spider 代码；
2. 未信任来源的会话状态为 `confirmation_required`，UI 展示警告；
3. 用户调用 `confirmImport()` 后写入信任文件；
4. 新会话重新读取同一信任文件后跳过首次确认，但仍保留可观察的播放不可用状态。

## 真实验证

```text
npm run spike:douban-desktop-session
```

探针使用 `csp_Douban` 配置和真实 Frodo endpoint，通过 `DesktopSpiderSession` 完成：

```text
confirm → init → homeContent → categoryContent → searchContent → detailContent → destroy
```

本地 fixture 测试还覆盖了：

- 未确认时阻止 `open`；
- 搜索结果 `msearch:<id>` 原样进入详情；
- RPC 错误保留且 sidecar 继续存活；
- 超时后统一标记 `SPIDER_TIMEOUT`，sidecar 不再运行；
- `destroy()` 后状态为 `destroyed`。

## 决策

Spike 13 只接入元数据/详情调用，不引入通用 `playerContent`。Douban 的正片播放源仍由 Spike 12 的结论约束；若未来需要播放，应接入独立来源解析器。
