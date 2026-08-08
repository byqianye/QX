# QX影视 用户指南

## 分章节阅读

- [安装与升级](installation.md)
- [首次启动](first-start.md)
- [配置导入](config-import.md)
- [点播与详情](vod.md)
- [直播与 EPG](live-tv.md)
- [本地媒体](local-media.md)
- [下载](downloads.md)
- [投屏](casting.md)
- [Web 控制台](web-console.md)
- [备份与恢复](backup-restore.md)
- [故障排查](troubleshooting.md)
- [隐私与安全](privacy-security.md)
- [已知限制](known-limitations.md)

## 安装、升级与卸载

运行 `QX影视-0.1.0-setup.exe` 完成 per-user 安装。安装器不要求把 Java、Python、mpv 或 aria2 预装到系统 PATH 中。升级时直接运行新版本安装器；应用数据和数据库迁移由应用保留，不要在升级前手动删除 `%APPDATA%\QX影视`。

卸载默认保留用户数据。只有在卸载器中主动勾选“删除 QX影视用户数据”时，设置、历史和缓存目录才会被删除。需要保留数据时先使用 Settings → Backup & Restore 创建备份。

## Portable 模式

将 portable 包解压到一个可写目录，并保持 `QX影视.exe` 与 `data` 目录同级。portable 数据只写入该目录的 `data` 子目录，不应与安装版数据混用。安装版和 portable 版同时使用时，请分别备份各自的数据目录。

## 导入与播放

QX影视只处理用户自行提供且有权访问的配置、媒体文件、直播源和服务地址。首次导入后检查预览内容，再确认信任。播放失败时先查看错误详情、源状态和线路选择；不要把私人 URL、Cookie、Authorization 或服务 Token 粘贴到公开 issue 或日志中。

## 本地媒体、下载和备份

- Local Media 扫描用户选择的本地目录，并保留路径、大小和修改时间等索引信息。
- Downloads 使用包内 aria2；RPC 仅监听本机，应用退出时会清理下载进程。
- 播放使用包内 mpv 作为桌面后端之一；应用退出时会清理 mpv 进程。
- Backup & Restore 默认不导出凭据、活动会话或临时媒体 URL；恢复前会进行兼容性检查并在失败时保留保护副本。

## 运行时与故障排查

正式 Windows 包自带固定版本运行时，并检查包内文件完整性。不要设置 `JAVA_HOME`、`PYTHONHOME`、`PYTHONPATH`、`PYTHONUSERBASE` 或 `VIRTUAL_ENV` 来改变正式包的运行时选择。若看到 `BUNDLED_JRE_MISSING` 或 `RUNTIME_INTEGRITY_FAILED`，请重新下载安装包并保留错误代码；不要用系统 Java/Python 覆盖发布目录。

若下载或播放失败：

1. 确认目标 URL 和服务仍由你控制或授权访问；
2. 检查 Windows 防火墙是否允许应用访问本机 fixture/服务端口；
3. 查看 Settings 中的诊断信息和源健康状态；
4. 提交问题时只提供脱敏后的错误代码、版本和系统架构。

## 当前已知限制

G73 的品牌/icon/startup/about 视觉审查和 G76 的 clean Windows 安装、升级、卸载、离线及非 ASCII 路径矩阵仍是发布门槛。完成前不要把当前构建称为稳定生产版。
