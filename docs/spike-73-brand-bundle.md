# G73 品牌、启动页与 bundle 复核

状态：`g73_open_design_review_required`。依赖：G72。

## 已完成的工程检查

- NSIS 构建产物包含 `resources/electron-runtime` 四类包内运行时；
- electron-builder 的 `win-unpacked` 目录可生成，portable `electron-packager` 路径未改；
- renderer 当前仍为单个约 820 kB 的 JS chunk，构建警告已记录；
- 当前安装器输出使用 electron-builder 默认图标。

## 阻塞项

本次会话没有可调用的 Open Design transport，不能对 icon、brand mark、startup/about 页面和 installer icon 做符合计划要求的视觉生成/复核，也不应自行伪造一个“Open Design 已验收”的结果。

已有设计资料仍在 `docs/design/open-design/`，待 Open Design transport 可用后，需要对照这些资料完成：

1. 应用图标与安装器图标；
2. 启动/关于页品牌呈现；
3. 资源加载与 lazy chunk 复核；
4. packaged screenshot 与视觉回归记录。

在上述复核完成前，G73 不得标记 completed，后续产物也不得宣称稳定生产发布。
