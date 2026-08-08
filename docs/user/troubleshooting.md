# 故障排查

## 启动失败

正式 Windows 包自带固定 JRE、CPython、mpv 和 aria2。看到 `BUNDLED_JRE_MISSING` 或 `RUNTIME_INTEGRITY_FAILED` 时，重新下载安装包，不要用系统 Java/Python 覆盖发布目录，也不要依赖 `JAVA_HOME`、`PYTHONHOME` 或 `PYTHONPATH` 修复正式包。

## 导入、播放或下载失败

确认目标服务仍可访问且你有权限；检查来源状态、线路、局域网防火墙和磁盘空间；再查看 Settings 中的诊断信息。提供反馈时只提交脱敏错误代码、应用版本和系统架构。

## 进程清理

应用退出时会清理由它启动的 mpv、aria2 和相关服务。若任务管理器仍有残留，先等待退出流程完成，再重启应用；不要终止不属于 QX影视 的系统或其他应用进程。
