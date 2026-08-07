# G72 Windows NSIS 安装器

状态：完成（安装器工程范围）。依赖：G71。

## 产物与策略

`npm run electron:installer:win` 使用 electron-builder 生成 `dist/installer/QX影视-0.1.0-setup.exe`，目标为 Windows x64 NSIS。安装器配置为 per-user，不注册文件关联，创建桌面和开始菜单快捷方式；原有 `electron:package:win` portable 目录保持不变。

卸载默认保留 `%APPDATA%` 下的用户数据。NSIS 卸载组件提供一个默认未勾选的“删除 QX影视用户数据”选项，只有用户主动勾选才删除设置、历史和缓存目录。升级使用 electron-builder 的标准旧版本迁移流程，不删除用户数据。

## 验证结果

- installer-config tests：2 assertions passed；
- NSIS build：passed；
- generated setup artifact：171,226,155 bytes；
- SHA-256：`89a1d8a1d17385b5080e156bc67f692217d1b3e052ea6b7aa2623cff581877cb`。

在 clean Windows VM 上的安装、升级、卸载交互验证属于 G76 外部验证门槛，本地构建成功不等价于该门槛已完成。
