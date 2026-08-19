# QX影视 Windows x64 打包审计

## Windows Preview Package V1（2026-08-09）

本节是本 Goal 的最终审计补充，旧版审计内容保留不改。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Preview builder 配置 | PASS | `electron-builder.preview.yml` |
| ASAR | PASS | `release/preview/win-unpacked/resources/app.asar` |
| Android Host APK | PASS | `resources/android-host/android-spider-host.apk`，由 `extraResources` 注入 |
| Packaged path | PASS | 运行时通过 `process.resourcesPath` 定位 APK/runtime |
| 用户数据/cache/log | PASS | 运行时使用 `app.getPath("userData")`；Spider cache 不写入项目目录、resources 或 ASAR |
| renderer | PASS | 静态 Vite 产物；无生产 localhost dev server；hls.js 随 renderer 打包 |
| security | PASS | `contextIsolation=true`、`nodeIntegration=false`、`webSecurity=true` |
| 无设备启动 | PASS | Preview smoke 使用不存在的 `QX_ANDROID_DEVICE_SERIAL`，应用仍完成既有 E2E |
| 真实 Android 播放 | BLOCKED | 当前设备在 Host 初始化阻塞后变为 ADB `offline`；详见 `docs/reports/testing/PACKAGED-PLAYBACK-REAL-TEST.md` |

Preview 产物只用于测试/预览，不声明签名、自动更新或独立 Windows Android Spider 能力。

状态：审计完成，待按本报告执行正式 `release/` 打包。

审计日期：2026-08-08

## 结论

当前项目已经稳定使用 Electron + TypeScript + Vite + electron-builder，不需要迁移到 Electron Forge 或 electron-vite。现有构建可以生成并运行 Windows x64 unpacked 包，现有 NSIS 配置和 bundled runtime 也已存在。

本 Goal 的最小改动范围是：

- 将 electron-builder 配置集中到 `electron-builder.yml`；
- 保留现有 `tsc + Vite + package-runtime` 构建链；
- 将正式产物统一输出到 `release/`；
- 同时生成 x64 NSIS 与 Portable；
- 增加 `prepack-check`，在 builder 前阻止明显缺失或开发残留；
- 统一正式包的 runtime 资源路径，并补充生产日志与最终交付报告。

## 当前项目结构

| 项目 | 当前事实 |
| --- | --- |
| Electron 主进程源码 | `src/electron/main.ts` |
| Electron 主进程输出 | `dist/electron/src/electron/main.js` |
| Electron 编译入口 | `package.json.main` 指向上述文件 |
| Vue renderer 源码 | `renderer/` |
| Vue renderer 输出 | `dist/renderer/index.html` 与 `dist/renderer/assets/` |
| bundled runtime 输出 | `dist/electron-runtime/` |
| runtime 内容 | bundled JRE、Python、mpv、aria2、JVM JAR、manifest |
| 应用图标 | `build/assets/qx-yingshi.ico`，包含 256/128/64/48/32/16 六种尺寸 |
| preload | 当前架构未使用 preload；BrowserWindow 使用安全的 `contextIsolation: true` 与 `nodeIntegration: false` |
| Electron renderer 服务 | 主进程启动本地动态端口 HTTP UI server，renderer 资源来自打包后的 `app.asar/dist/renderer` |

## 当前 build 系统

- Electron：`43.3.0`（package.json 约束为 `^43.3.0`）。
- Electron builder：`26.15.3`（package.json 约束为 `^26.15.3`）。
- Vite：`7.3.6`，配置为 `vite.config.ts`，renderer 输出到 `dist/renderer`。
- TypeScript：`tsconfig.electron.json` 将主进程及其运行时依赖输出到 `dist/electron`。
- runtime 构建：`src/electron/package-runtime.ts` 输出 `dist/electron-runtime`。
- 当前开发启动：`npm run electron:dev`，先构建再执行 `electron .`。
- 当前测试：`npm test`；类型检查：`npm run typecheck`。

## 当前 packaging 配置

当前配置位于 `package.json.build`：

- `asar: true`；
- `files` 已限制为 `dist/electron/**/*`、`dist/renderer/**/*` 和 `package.json`；
- `dist/electron-runtime` 作为 `extraResources` 复制到 `resources/electron-runtime`；
- 图标复制到 `resources/brand/qx-yingshi.ico`；
- NSIS 已配置为 per-user、可选择安装目录、桌面/开始菜单快捷方式，并默认保留用户数据；
- 当前仅构建 NSIS，输出为 `dist/installer`，尚未提供本 Goal 要求的统一 `release/` 目录和 Portable target。

另有 `electron-packager` 脚本输出到 `dist/electron-package`，它保留为既有 packaged E2E/兼容验证入口；正式分发改用 electron-builder。

## 已验证的运行时边界

- 正式包通过 `process.resourcesPath/electron-runtime` 定位 bundled runtime。
- 开发包目前通过项目构建输出定位 runtime；本 Goal 会把这个分支集中到 `RuntimePathResolver`，避免业务代码散落固定路径。
- JS Spider Worker 优先使用编译后的 `js-spider-worker.js`，只有开发环境缺少编译文件时才回退到 `.ts + tsx/esm`。
- Local playback proxy、Web control 和 cast bridge 默认申请动态端口；没有以固定端口作为唯一选择。
- `app.getPath("userData")` 是普通安装模式的数据根；项目已有 G55 portable-data 设计，只有 packaged 的 `QX影视.exe` 旁存在 `data/` 时才进入 portable 模式。
- 主进程关闭流程已有 shell、UI server、proxy、sidecar、播放器、download、cast、web control 和 SQLite 清理链，并有对应生命周期测试。
- Electron 安全设置已保持 `contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`；本 Goal 不修改这些安全边界。

## 需要修改的文件

1. `package.json`：移除重复的内嵌 builder 配置，增加 `build`、`pack`、`prepack-check`、`dist:win*` 等清晰脚本，同时保留现有开发和测试脚本。
2. `electron-builder.yml`：集中声明正式包文件范围、ASAR、runtime `extraResources`、NSIS、Portable 和 x64 target。
3. `scripts/prepack-check.ts`：检查版本、真实 build 输出、图标、bundled runtime、开发路径残留和 `release/` 可写性。
4. `src/electron/runtime-paths.ts` 与 `src/electron/main.ts`：统一开发/打包资源路径和用户数据/日志路径。
5. 生产日志模块与主进程错误钩子：记录启动上下文和 fatal error，避免记录 Cookie、Token 等敏感信息，并限制日志大小。
6. 相关现有测试与打包 E2E 辅助脚本：改为读取独立 builder 配置和 `release/` 产物名称。
7. `docs/reports/testing/WINDOWS-BUILD-REPORT.md`、`docs/reports/testing/WINDOWS-SMOKE-TEST.md`：在最终构建后生成。

## 潜在问题与处理口径

- Android DEX runtime 不属于当前 JVM-native runtime；如果真实媒体链被该限制阻断，报告为 `blocked by Android DEX Runtime`，不伪造播放成功。
- 当前 Goal 允许生成未签名测试包，最终报告必须明确 `SIGNED=false`；不使用绕过 Windows 信誉提示的方案。
- 本机验证不是 pristine clean Windows 证据。项目已有 `docs/clean-windows-test-plan.md`，最终报告将区分本机 local clean-room 与未执行的 pristine clean environment。
- Portable target 使用 electron-builder 的 Portable 包格式；用户数据仍遵循项目既有 DataDirectoryResolver 契约，不擅自把数据写入 exe 所在目录。
- `preload` 在当前架构中不适用，不能为了满足检查项创建无用途的空 preload；打包范围以实际 BrowserWindow 入口为准。

## 基线验证

- `npm test`：通过，81 个测试文件、457 个测试。
- `npm run typecheck`：通过。
