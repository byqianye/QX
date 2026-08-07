# G69：Backup & Restore

## Status

G69 已完成。备份与恢复复用现有 SQLite 数据层和 normal/portable 目录解析；备份是版本化 ZIP，恢复只提供 Replace 路径。

## Backup scope

默认备份包含 SQLite 业务数据库和 `trusted-sources.json` 的受限元数据：settings、来源/站点配置、历史、播放进度、收藏与分组、追更、直播源、EPG、Smart Channel、弹幕设置以及下载任务 metadata。缓存目录默认不导出，可在 Settings → Backup & Restore 显式勾选。

备份通过 `node:sqlite` 的 backup API 生成一致性快照，不直接复制正在运行的数据库文件。快照在进入 ZIP 前会移除敏感 settings（包括 Web PIN 摘要与 session/token/cookie/credential 类键）；活动 Web session、Cookie、Authorization、LocalProxy/Jellyfin/aria2 凭据、临时媒体 URL 和播放器 IPC 不进入导出备份。应用本地的 pre-restore 保护副本只用于失败回滚，不是导出功能。

## Format and compatibility

容器包含：

- `manifest.json`：`formatVersion`、`appVersion`、`createdAt`、sections、SQLite schema version、记录摘要和 SHA-256 checksums；
- `data/database.db`：经过 sanitization 的 SQLite backup；
- 可选 `data/trusted-sources.json`；
- 可选 `cache/` 文件。

当前支持 format version 1，并接受 version 0 进入 migration-required 预览路径。未知的新版本返回 `BACKUP_VERSION_TOO_NEW`，不猜测恢复。

## Archive security

ZIP reader 只接受 UTF-8 相对路径，拒绝 `..`、`.`、绝对路径、盘符、UNC、反斜杠和 symlink 条目。entry 数量、单项大小、总解压大小、压缩比和 ZIP64 均受限；manifest checksums、ZIP CRC 和业务条目 allowlist 都必须通过后才写入 staging。

## Restore strategy

1. 读取并验证 archive、manifest、checksum 和路径。
2. 将数据库与可选文件写入同卷 staging 目录。
3. 用 `SqliteDataLayer.create` 执行现有 migration sequence，并执行 integrity check。
4. UI 只展示版本、时间、sections 和记录摘要；用户明确确认后才继续。
5. 停止 Electron 当前服务并关闭 DB，创建 pre-restore 保护副本。
6. 原子替换数据库、信任元数据和（若备份包含）缓存；失败时恢复旧文件。
7. 成功后 relaunch，使所有服务重新打开当前 normal/portable DataRoot。

首版不做 Merge；恢复冲突不自动合并。

## Verification

```powershell
npx vitest run tests/backup-restore.test.ts tests/desktop-ui.test.ts tests/vue-renderer.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
npm run typecheck
npm run renderer:build
```

## Checkpoint

```text
checkpoint: complete G69 backup restore
```
