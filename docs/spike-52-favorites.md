# Spike 52：收藏与分组

## Goal

在 G50 SQLite 数据层和 G51 稳定内容身份之上，建立可重启保留的收藏闭环。收藏是内容元数据快照，不是播放会话快照。

## Decisions

- 唯一身份是 `sourceId + vodId`。同一 source 的同一 vod 只能有一条收藏；不同 source 即使标题相同也分别保留。
- 收藏保存 `title`、安全海报、年份、分类、来源显示名、时间、分组、手动顺序和可选安全 metadata。临时播放 URL、Proxy URL/token、Cookie、Authorization、IPC 地址和本机路径不进入 SQLite。
- 应用启动时保证 `default` 默认分组存在。自定义分组可以创建、改名、排序和移动收藏；默认分组不可删除。
- 删除非空分组不是隐式行为。调用方必须明确选择 `default`（把收藏移到默认分组）或 `delete`（删除收藏）；两种操作与分组删除在同一 SQLite transaction 内完成。
- 手动排序要求提交目标分组的完整收藏 ID 列表，并在 transaction 内重写 `sort_order`；不完整、重复或跨分组 ID 直接拒绝。
- “最近观看”仅使用 G51 history 中相同 `sourceId + vodId` 的最新 `updated_at`。没有历史的收藏排在有历史收藏之后，但收藏本身不会因缺少历史而删除。
- 来源可用性由当前活动 source 与收藏 sourceId 比较得出。不可用时收藏原样保留，页面只提供删除或以标题搜索其他来源，不自动替换 source。

## Data boundary

`FavoritesService` 是主进程唯一业务入口；Renderer 只接收 `FavoritesUiState`。`FavoritesRepository` 负责 prepared statement、schema 字段映射和 transaction 边界。G52 将 `favorites` schema 从 v1 迁移到 v2，新增安全展示字段 `year`、`category`、`source_name`。

## Verification evidence

- `tests/favorites.test.ts`：身份去重、同标题跨源、隐私过滤、分组删除决策、排序、源不可用和重启。
- `tests/vue-renderer.test.ts`：Favorites 页面、Sidebar 路由、分组/收藏事件和详情页收藏按钮。
- `tests/electron-e2e.test.ts`：HTTP API 收藏、创建/移动分组、详情打开和持久化服务接线。
- `src/electron/e2e-launch.ts`：Windows packaged first/restart E2E 读取 SQLite 收藏行，确认至少一条收藏持久化且不含 URL、凭据或临时播放路径。

## Risks and non-goals

- 本 Goal 不实现真实影视源搜索替换、不实现源适配器健康检测，也不宣称所有历史 source descriptor 都可恢复。
- source disabled/deleted 的产品状态由当前活动 source 上下文表达；收藏行不会被自动清理。
