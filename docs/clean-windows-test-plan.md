# G76 clean Windows validation plan

状态：`passed_local_windows_clean_room`（不等同于 pristine clean-Windows）。

当前工作区已完成 automatable validation：release-mode runtime build、portable packaged first/restart E2E、NSIS artifact build、no-JDK check、真实 mpv/aria2 smoke、依赖审计和 runtime hash manifest。当前机器没有可供本任务创建和重置的 clean Windows VM；本机已有 Node/JDK/Python 与构建缓存，不能作为 clean-VM 证据。

## 后续本机 clean-room 方案（不使用虚拟机）

G76 后续改在当前物理 Windows 上执行隔离验收，不再启动或依赖虚拟机。该路径的证据标签为 `local_windows_clean_room`，不能把本机隔离结果伪装成 pristine clean-VM 结果。

1. 在用户临时目录创建唯一的安装、数据、日志和结果目录；开始前拒绝覆盖已有的 QX 桌面/开始菜单快捷方式。
2. 通过当前 per-user NSIS 安装器安装到临时目录，再以同一安装目录重复安装，检查升级幂等、快捷方式不重复和用户数据保留。
3. 启动已安装程序时只传入 `QX_E2E_USER_DATA` 等临时路径，并清空 `JAVA_HOME`、`JDK_HOME`、`JRE_HOME`、`PYTHONHOME`、`PYTHONPATH`、`PYTHONUSERBASE`、`VIRTUAL_ENV`、`NODE_PATH` 及 `QX_*_PATH` 覆盖项；`PATH` 仅保留 Windows 基础目录。
4. 使用 `QX_ELECTRON_FORCE_NO_EXTERNAL_JAVA=1`，以安装目录下的 `resources/electron-runtime` 运行 packaged E2E；再把同一 bundled runtime 目录传给真实 Python、mpv、aria2 smoke，不使用 fake runtime 作为运行时证据。
5. 记录安装器/portable hash、运行时实际路径、进程命令行、临时端口、退出码、数据保留和卸载后的路径清理；任何残留进程、端口或用户快捷方式都使本轮失败。

本机 clean-room 能验证发布包在“现有物理 Windows + 无外部运行时环境变量 + 隔离用户数据”下的行为；它仍不能证明操作系统镜像本身没有预装运行时。因此 G76 的 `clean-Windows` 原始门禁只有在用户接受该替代证据口径后才可解除。

## 原始 pristine 方案（已放弃）

原始方案需要一台全新 Windows 10 22H2 或更高、Windows x64 虚拟机/实体机；按用户指示不再采用该路线：

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
