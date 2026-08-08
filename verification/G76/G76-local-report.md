# G76 本机 clean-room 验收报告

状态：`passed_local_windows_clean_room`

执行日期：2026-08-08。按用户要求，本轮不使用虚拟机，直接在物理 Windows 主机执行；证据范围是 `physical_windows_local_clean_room_not_pristine_clean_vm`。

## 当前安装器

- `dist/installer/QX影视-0.1.0-setup.exe`
- 170,781,832 bytes
- SHA-256：`5582A22DE97136776AC984BBC6CB21751F3998B5D2E24B5AAFE053D2CAE15C5A`

## 已通过的本机矩阵

- 唯一临时目录安装，安装路径含中文：安装目录、桌面快捷方式、开始菜单快捷方式和首次启动均通过。
- 已安装包 first/restart fixture E2E 通过；覆盖导入、搜索、详情、播放、解析链、规则、sniff、代理、字幕、弹幕、Live/EPG/Smart Channel/failover、历史、收藏、追更、本地媒体、下载、推送、DLNA、Web Console、PIN、备份和清理。
- G76 本机安装包 E2E 的下载步骤使用安装目录内真实 aria2；真实 bundled Python、mpv、aria2 smoke 均从安装目录 `resources/electron-runtime` 执行。
- 清空外部 Java/Python/runtime 覆盖变量，`PATH` 仅保留 Windows 基础目录，并强制禁用外部 Java；bundled JRE manifest 和运行时路径检查通过。
- 同一版本同目录重装通过，用户数据 marker 保留，快捷方式未重复。
- 第二次已安装包 E2E 通过，并验证旧用户数据 marker 仍在。
- 静默卸载通过：应用目录和快捷方式删除，用户数据保留；卸载后项目进程和监听端口均为空。

完整机器可复核结果见 [`G76-local-report.json`](G76-local-report.json)。

## 明确边界

- 这是物理 Windows 的隔离临时目录/数据/环境验收，不证明操作系统镜像本身没有预装 Node、JDK、Python、mpv 或 aria2，因此不标记为 pristine clean-Windows。
- “升级”本轮是同版本安装器的幂等重装；真实旧版本到当前版本的迁移仍未执行。
- 便携模式的解析、迁移、可写性和数据目录契约由全量测试覆盖；本轮没有把 dist unpacked 目录另行包装成最终 portable ZIP。
- 未执行系统级断网；网络错误路径由 `electron:verify:network-timeout` 和单元/集成测试覆盖，完整离线启动矩阵仍需真实断网条件。
- 本轮验证默认卸载保留数据；卸载器的“主动删除用户数据”选项已有配置/installer E2E 覆盖，但未在本机 clean-room 报告中宣称已执行该交互分支。
