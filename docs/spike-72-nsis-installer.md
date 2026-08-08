# G72 Windows NSIS 安装器

状态：完成（安装器工程范围）。依赖：G71。

## 产物与策略

`npm run electron:installer:win` 使用 electron-builder 生成 `dist/installer/QX影视-0.1.0-setup.exe`，目标为 Windows x64 NSIS。安装器配置为 per-user，不注册文件关联，创建桌面和开始菜单快捷方式；原有 `electron:package:win` portable 目录保持不变。

卸载默认保留 `%APPDATA%` 下的用户数据。NSIS 卸载组件提供一个默认未勾选的“删除 QX影视用户数据”选项，只有用户主动勾选才删除设置、历史和缓存目录。升级使用 electron-builder 的标准旧版本迁移流程，不删除用户数据。

## 验证结果

- installer-config tests：2 assertions passed；
- NSIS build：passed；
- latest generated setup artifact：170,781,832 bytes；
- SHA-256：`5582A22DE97136776AC984BBC6CB21751F3998B5D2E24B5AAFE053D2CAE15C5A`。
- 本机临时目录 installer E2E：安装、桌面/开始菜单快捷方式、已安装包 first/restart/backup fixture E2E、静默卸载和文件清理均通过；G76 另有物理 Windows local clean-room 报告，范围不等同于 pristine clean-Windows。

electron-builder 的 description/author 元数据已设置。当前仍使用默认 Electron icon，属于 G73 Open Design 视觉审查范围，不能视为视觉验收通过。

真实旧版本升级与系统级离线交互仍属于 G76 的未覆盖边界；本项目当前采用用户指定的物理 Windows local clean-room 证据口径，不再启动虚拟机。
