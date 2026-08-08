# G73 品牌、启动页与 bundle 复核

状态：`g73_self_review_passed`。依赖：G72。

## 已完成的工程检查

- NSIS 构建产物包含 `resources/electron-runtime` 四类包内运行时；
- electron-builder 的 `win-unpacked` 目录可生成，portable `electron-packager` 路径未改；
- renderer 主 chunk 约 779 kB，Downloads/LocalMedia/EpgSources/LiveSources 已拆为独立 lazy chunks；构建警告已记录；
- 安装器与 unpacked 资源均接入本地六尺寸 `qx-yingshi.ico`。

## 当前阻塞项

OpenDesign 已生成可追溯的 `qx-g73-visual-spec.html` 与 `qx-g73-visual-handoff.md`，但内置 HTML 预览无法取得 workspace context。按用户明确指示，已用独立 light/dark 预览、真实 packaged 截图、ICO 接线和临时安装快捷方式元数据完成仓库侧自审；自审通过，但不把 OpenDesign 的 workspace-context 路径伪装成通过。

工程侧交付已经落在 `docs/design/open-design/release/` 与应用代码中，包含：

1. `build/assets/qx-yingshi-mark.svg` 与六尺寸 `qx-yingshi.ico`；
2. Electron 主窗口、独立播放器窗口、electron-packager 与 electron-builder 的同源图标接线；
3. 启动 splash、首启引导、About 面板和四个路由 lazy chunks；
4. 本地无 CDN 的发行视觉规范 HTML、handoff 规格和验收矩阵。

已补充真实 packaged E2E 截图矩阵：首次运行与重启运行各有首启 light/dark 截图，并各有 About light/dark 截图。截图来自实际 Windows unpacked package，不是静态 HTML 替代物；具体文件、字节数与 SHA-256 见 `verification/G73/packaged-visual-matrix.txt`。

自审结论：

1. light/dark 预览与 packaged 首启/About 截图的层级、对比度、间距、品牌标记和重启一致性通过；
2. 六尺寸 ICO、Electron/NSIS 同源图标接线通过；临时安装的桌面与开始菜单快捷方式均指向安装后的可执行文件并使用其嵌入图标，静默卸载后清理通过；
3. 离线资源扫描与四个 lazy route chunk 检查通过。

G73 已按本次用户授权的自审路径完成；G76 clean Windows 验证仍是独立门禁，不能由本地自审替代。
