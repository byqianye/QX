# G106 Packaged UI E2E

状态：`PASS（win-unpacked + NSIS Installer）`

已使用本轮重建的 `release/preview/win-unpacked/QX影视.exe` 运行 `npm run preview:smoke` 并生成 after 截图。导入、来源、搜索/详情、播放器、HLS、LocalProxy、重启、下载、缓存等检查全部通过，最终 `localMediaRestart` 也为 true。

截图保留在 `tmp/g106-baseline/` 和 `tmp/g106-after/`。NSIS 安装包已完成安装、启动、packaged E2E、卸载与用户数据保留检查；预览包的 Start Menu 分类使用 `QX影视 Preview`。本次 packaged smoke 使用确定性 fixture；真实 Jianpian/Android Clean E2E 沿用 G105 已通过证据，未在本轮重复启动外接真机。

本轮实现后重新执行：`npm run preview:smoke` = PASS；当前预览 NSIS 安装态 = PASS（安装、桌面/开始菜单快捷方式、打包启动、卸载、用户数据保留）。

G106-I 已修改 4 项本地 UI RELEASE_BLOCKER，并用当前重建包重新验证；没有修改 Android Runtime、Host 或播放核心。Open Design Cloud 最终设计审查仍因 `AMR_INSUFFICIENT_BALANCE` 失败且 `artifactCount=0`；因此 packaged UI E2E 的 `PASS` 不等于 `QX_FINAL_UI_V1` 已通过。
