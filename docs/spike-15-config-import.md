# Spike 15：真实配置导入闭环

## 目标与边界

Spike 14 的 UI 使用探针预先创建的 `DesktopSpiderSession`。本 Spike 增加 `DesktopSpiderImportController`，把用户输入接入现有 UI server：

- 支持 URL、Windows 文件路径和原始 JSON；原始 JSON 也经过现有 TVBox/FongMi 解码器。
- 先读取、解析、总结配置并显示执行代码警告；确认前不调用 session factory，因此不会创建 Spider/sidecar。
- 信任确认写入 `ImportTrustStore` 的持久化存储。
- 从配置站点中选择并只允许 `csp_Douban`，选中的 `ext` 用于 `init(ext)`。
- 重复导入先销毁旧 session；已确认来源重新导入时跳过警告但仍创建新的 session。
- 取消确认不写入信任，也不创建 session；网络、文件和 JSON 错误分别保留可诊断状态。

## UI action

导入模式使用同一个 `DesktopSpiderUiServer`：

```text
/api/import/load
/api/import/select
/api/import/confirm
/api/import/cancel
```

确认成功后切换到原有 Spider UI，继续调用：

```text
open → home → category → search → detail
```

本 Spike 仍不增加 `playerContent`；详情页继续显示 Douban 无正片播放源。

## 验证

本地稳定测试：

```text
npx vitest run tests/spider-import.test.ts
```

覆盖 URL、文件、原始 JSON、无效配置、网络失败、确认前零 session、取消、站点选择和重复导入。

真实 Douban 验收：

```text
npm run spike:douban-desktop-import
```

探针通过真实导入 action 完成确认、选站、首页、分类、搜索、详情和关闭，并验证：

- 确认前 `createdSessions = 0`；
- 搜索结果仍为 `msearch:<id>`，详情 ID 保持一致；
- 持久化信任后的重复导入不再显示首次警告；
- 关闭后 sidecar 已停止。
