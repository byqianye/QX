# G76 clean Windows validation plan

状态：`blocked_external_clean_windows_validation`。

当前工作区已完成 automatable validation：release-mode runtime build、portable packaged first/restart E2E、NSIS artifact build、no-JDK check、真实 mpv/aria2 smoke、依赖审计和 runtime hash manifest。当前机器没有可供本任务创建和重置的 clean Windows VM；本机已有 Node/JDK/Python 与构建缓存，不能作为 clean-VM 证据。

## 执行环境

需要一台全新 Windows 10 22H2 或更高、Windows x64 虚拟机/实体机：

- 不预装 Node.js、JDK、Python、mpv、aria2；
- 不设置 `JAVA_HOME`、`PYTHONPATH`、`PYTHONHOME`；
- 无旧版 QX 影视用户数据，随后再单独测试带旧版数据的升级路径；
- 记录 OS build、架构、安装包 SHA-256、开始/结束时间。

## 矩阵

1. 首次安装：per-user 目录、开始菜单/桌面快捷方式、启动和退出；
2. 无宿主 Java/Python/mpv/aria2：JVM Spider、Python Spider、mpv、aria2 smoke；
3. 设置 `JAVA_HOME` / `PYTHONPATH` 指向恶意或错误路径：应用仍使用包内 runtime；
4. 断电式/强制退出后重启：用户数据、aria2/mpv 子进程和 localhost 端口清理；
5. 从旧版安装器升级：数据保留、版本一致、快捷方式不重复；
6. 卸载默认选项：不勾选删除数据时保留 `%APPDATA%`；勾选后只删除用户数据；
7. portable 包：与 NSIS 安装器隔离，数据目录和启动行为保持既有契约；
8. 多次安装/卸载与失败回滚：无残留进程、无异常端口占用。

## 通过条件

全部矩阵项通过，安装包与 portable 的 SHA-256、版本和 runtime manifest 一致，且没有 Critical/High 未解决项，才能解除本状态。当前不推进 G77 RC_READY 或 G78 release_candidate_ready。
