# G72 Windows NSIS 安装器

状态：完成（安装器工程范围）。依赖：G71。

## 产物与策略

`npm run electron:installer:win` 使用 electron-builder 生成 `dist/installer/QX影视-0.1.0-setup.exe`，目标为 Windows x64 NSIS。安装器配置为 per-user，不注册文件关联，创建桌面和开始菜单快捷方式；原有 `electron:package:win` portable 目录保持不变。

卸载默认保留 `%APPDATA%` 下的用户数据。NSIS 卸载组件提供一个默认未勾选的“删除 QX影视用户数据”选项，只有用户主动勾选才删除设置、历史和缓存目录。升级使用 electron-builder 的标准旧版本迁移流程，不删除用户数据。

## 验证结果

- installer-config tests：2 assertions passed；
- NSIS build：passed；
- generated setup artifact：170,803,813 bytes；
- SHA-256：`F561717C3708C4724EF4D6EF85EE0170702F76A936A5133AF0C098506E552173`。

electron-builder 的 description/author 元数据已设置。当前仍使用默认 Electron icon，属于 G73 Open Design 视觉审查范围，不能视为视觉验收通过。

在 clean Windows VM 上的安装、升级、卸载交互验证属于 G76 外部验证门槛，本地构建成功不等价于该门槛已完成。
