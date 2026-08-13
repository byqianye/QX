# QX影视 Windows x64 构建报告

构建日期：2026-08-08

## 构建信息

| 项目 | 结果 |
| --- | --- |
| 产品 | QX影视 |
| 应用版本 | 0.1.0 |
| 平台 | Windows x64 |
| Electron | 43.3.0 |
| electron-builder | 26.15.3 |
| Vite | 7.3.6 |
| TypeScript | 5.8.3 |
| Node.js（构建机） | v24.16.0 |
| npm（构建机） | 11.13.0 |
| JRE 构建工具链 | pinned Eclipse Temurin 21.0.7+6-LTS，64-bit |
| ASAR | true |
| 代码签名 | `SIGNED=false` / UNSIGNED |

## 最终产物

以下两个文件位于干净的用户分发目录，可直接发送给用户：

1. `C:\Users\qiany\Documents\ChatGPT\QX影视\release\distribution\QX影视-Setup-0.1.0-x64.exe`
2. `C:\Users\qiany\Documents\ChatGPT\QX影视\release\distribution\QX影视-Portable-0.1.0-x64.exe`

| 产物 | 完整路径 | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| Setup | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\QX影视-Setup-0.1.0-x64.exe` | 171,225,609 bytes | `E76493C8278E35CCAF1D6BDA0AC2AA56D190C45A907F194D50CA0216B09F29A6` |
| Portable | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\QX影视-Portable-0.1.0-x64.exe` | 153,825,972 bytes | `0540610B1081181BB14C0CCEC7AFFAA04B6B65FC5EEAAA31548A3E7352152341` |
| win-unpacked exe | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\win-unpacked\QX影视.exe` | 225,441,792 bytes | `BEF0FD49B0FD6AA02E7FB200297BB9260C8A92AD2B274E7E4615FC865BB44AA8` |

`release/distribution/` 只复制 Setup 与 Portable；`release/` 根目录中的 unpacked、builder-debug 和 blockmap 等内容不作为用户分发目录。

## 构建命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | PASS：82 个测试文件，459 个测试 |
| `npm run typecheck` | PASS |
| `npm run build` | PASS：strict release build，使用 pinned Temurin |
| `npm run prepack-check` | PASS |
| `npx electron-builder --dir --x64` | PASS：生成 `release/win-unpacked/` |
| `npx electron-builder --win nsis --x64` | PASS |
| `npx electron-builder --win portable --x64` | PASS |
| `npm run electron:installer:e2e` | PASS：安装、快捷方式、安装后 E2E、卸载和清理 |
| `npm run electron:e2e:unpacked` | PASS：unpacked 首次与重启两轮 |
| `npm run python:smoke` | PASS：bundled CPython |
| `npm run mpv:smoke` | PASS：bundled mpv |
| `npm run aria2:smoke` | PASS：bundled aria2 |
| `npm run lint` | 未执行：项目没有 lint script |

## 包内资源核验

`release/win-unpacked/resources/` 中已确认存在：

- `app.asar`，业务代码、renderer 和生产 package 元数据在 ASAR 内；
- `brand/qx-yingshi.ico`；
- `electron-runtime/runtime-manifest.json`；
- bundled JRE、CPython、mpv、aria2 及 JVM Spider JAR；
- 四类 runtime manifest 均为 `bundled=true`，执行文件 hash 校验通过。

正式运行时通过 `process.resourcesPath/electron-runtime` 定位只读 runtime；用户数据、缓存和日志不写入安装目录、`resources` 或 `app.asar`。

## 已知限制与风险

- 产物未签名。Windows 可能显示 SmartScreen/信誉警告；当前 Goal 不包含代码签名，也没有使用绕过安全提示的方案。
- 本轮是当前物理 Windows 的自动化与隔离目录验证，不是 pristine clean Windows 镜像证据；项目已有的 clean-room 口径见 `docs/clean-windows-test-plan.md`。
- 当前项目不提供 Android DEX runtime。遇到 DEX-only 来源时应报告 `blocked by Android DEX Runtime`，不能把受控 fixture 的播放验证扩大为第三方影视源能力声明。
- Vite 对主 renderer chunk 给出大于 500 kB 的提示；已有 lazy chunks，未影响构建或 smoke 结果。
