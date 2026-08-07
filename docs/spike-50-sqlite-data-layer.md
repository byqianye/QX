# G50：SQLite 正式数据层

## 状态

G50 已完成。正式数据层使用 Node `node:sqlite` 的同步 `DatabaseSync` API；开发测试与 Windows x64 packaged E2E 均可加载，不要求用户额外安装数据库程序，也没有引入 native addon/ABI 依赖。

当前 Electron 43.3.0 的 packaged E2E 已实际执行 SQLite 建库、schema migration、桌面状态写入、关闭和重启后的 DB 读取。运行时要求 Node `>=22.5.0`，以匹配 `node:sqlite` API。后续 G51—G55 继续复用本数据层；G55 再扩展统一目录解析器的 portable mode。

## 选择理由

| 方案 | 结论 |
| --- | --- |
| `node:sqlite` / `DatabaseSync` | 采用。当前 Node 类型声明包含 API；Electron packaged E2E 已证明实际运行时可加载。事务、prepared statement、只读打开和 integrity check 均可用。 |
| `better-sqlite3` | 未采用。需要额外 native addon 与 Electron ABI 构建/交付验证；本 Goal 没有必要增加该维护面。 |
| 外部 SQLite 程序 | 不采用。会把额外安装和进程生命周期交给用户，超出桌面应用边界。 |

所有业务 SQL 都位于主进程 `src/data/`，使用固定 SQL 和参数绑定。Renderer 没有 SQLite import、数据库路径或 arbitrary query API；Renderer 只继续通过既有 UI server/API 获得脱敏状态。

## 数据目录

G50 通过 `DataDirectoryResolver` 固定普通模式目录：

```text
<userData>/qx-yingshi.db
<userData>/cache/
<userData>/logs/
<userData>/temp/
<userData>/backups/
```

G50 不实现 portable mode 的判定、切换和迁移；这些能力留给 G55。当前模块不再自行拼接数据库路径。

## Schema 与迁移

`schema_migrations` 记录已成功应用的版本和时间。当前 schema version 为 `1`，初始迁移在单一 transaction 中建立：

- `settings`
- `config_sources`
- `config_versions`
- `sites`
- `history`
- `playback_progress`
- `favorites`
- `favorite_groups`
- `follow_items`
- `source_health`
- `stream_health`
- `cache_entries`
- `data_migrations`

迁移只有在 SQL 和版本记录都成功后才提交；失败会 rollback，不会伪造已完成版本。高于当前支持版本的数据库返回 `DATABASE_VERSION_TOO_NEW`，不执行降级写入。

## Repository 边界

`src/data/repositories.ts` 提供固定边界：

- `SettingsRepository`
- `HistoryRepository`
- `PlaybackProgressRepository`
- `FavoritesRepository`
- `FollowRepository`
- `HealthRepository`
- `CacheRepository`

批量删除、收藏排序、缓存 metadata 清理和 migration 使用 transaction。`PlaybackProgressWriter` 以 debounce + 最大 interval 合并高频进度，并提供 pause、stop、episode change、app close flush 点；G51 负责把这些入口接到实际播放流程。

## 旧数据迁移

`LegacyDataMigrator` 只在 `data_migrations` 没有对应标记时处理：

- `desktop-state.json` → `settings`
- `config-history.json` → `config_sources` / `config_versions`
- 可选 `source-health.json` → `source_health`
- 可选 `stream-health.json` → `stream_health`

每个文件的导入和迁移标记共享 transaction。源文件缺失时只报告 skipped，不写完成标记；源文件迁移失败时不标记完成、保留原文件，重启不会重复导入已完成的 migration。迁移器不删除旧文件。

配置历史、settings、收藏 metadata 和健康快照经过统一的持久化脱敏：Cookie、Authorization、token、密码、secret、LocalProxy/播放器 IPC 和临时播放地址不会原样写入 SQLite。

## 损坏与错误处理

数据库打开或 migration 失败时：

1. 尝试只读 integrity check；
2. 对损坏文件创建带时间戳的 `.corrupt-*.bak` 备份，不删除原文件；
3. 使用稳定的 `<database>.recovery.db` recovery database 继续启动，恢复期间写入的数据可在下一次启动复用；
4. 通过脱敏 `DATABASE_OPEN_FAILED`、`DATABASE_MIGRATION_FAILED`、`DATABASE_CORRUPT`、`DATABASE_VERSION_TOO_NEW` 或 `DATABASE_WRITE_FAILED` 暴露状态。

数据库写入错误不会把原始异常、完整用户路径、Cookie、Authorization、LocalProxy token、临时媒体 URL 或播放器 IPC 地址写进 UI 诊断。

## 验证入口

```powershell
npx vitest run tests/sqlite-data-layer.test.ts tests/data-repositories.test.ts tests/legacy-data-migration.test.ts
npm run typecheck
npm test
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
```

专项覆盖建库、首次/重复 migration、migration rollback、高版本 DB、prepared statement、transaction、DB lock、损坏文件、repository CRUD、旧 JSON 一次性迁移、重启状态和 DB handle close。G50 不提前实现历史 UI、收藏业务、追更、缓存清理 UI 或 portable mode。
