# G107 基线报告

日期：2026-08-13
分支：`codex/g107-tauri-baseline`
Stage 1 标签：`stage1-g106-final` → `5de04df`

## 审查结果

| 项目 | 结果 |
| --- | --- |
| 当前 HEAD（审查前） | `2d6c476 feat: integrate validated Android DEX runtime` |
| 工作区 | 已存在大范围 Stage 1 修改；未执行重置或破坏性清理 |
| `src-tauri` | 审查时不存在，G107 新建 |
| Rust stable / Cargo | 已锁定 `rust-toolchain.toml` 为 `1.97.1-x86_64-pc-windows-msvc`；`cargo fmt --check` 与 `cargo check` 已通过 |
| MSVC Build Tools | 已安装 Visual Studio 2022 Build Tools VC Tools 工作负载；常规 PowerShell 未自动加载 VS 开发环境 |
| Tauri CLI/API | 分别锁定 `2.11.4` / `2.11.1`；CLI help、Tauri dev 和 NSIS 构建已通过 |
| `npm test` | Stage 1 基线 PASS（104 个测试文件、549 个测试）；G107 后 PASS（105 个测试文件、552 个测试） |
| `npm run typecheck` | PASS |
| `npm run check:frontend` | PASS |
| `npm run check:rust` | PASS |
| `npm run electron:smoke` | PASS，`electron-smoke: ready` |
| 密钥扫描边界 | 未将 `.env`、运行时目录、缓存、日志、EXE、ZIP 和解包物纳入基线提交 |

## 筛选规则

纳入：源码、renderer、测试、文档、配置和可审计的测试 fixture。

排除：`tmp/`、EXE、ZIP、解包目录、反编译物、缓存、日志和运行时资产。排除项未删除，仍由用户决定后续处置。

## G107 验收目标

1. Vue/Vite 可被 Tauri 加载。
2. Rust backend 响应 `backend_app_snapshot` 真实 RPC。
3. RPC 请求/响应带 `version`、`requestId`、`sessionId`、`sequence`。
4. 数据目录使用 Tauri `AppLocalData`，数据库名固定为 `qx-v1.sqlite3`。
5. NSIS 配置使用应用标识 `com.qx.yingshi.desktop` 和 WebView2 bootstrapper。
6. Electron 实现和旧数据目录保持不变。

## G107 验证结果

- `npm run tauri:dev -- --no-watch`：PASS。Vite 在 `5173` 就绪，Rust dev binary 编译并启动 `QX影视` 窗口；Ctrl+C 后未发现本次启动的 Tauri、Cargo/Rust 或 Node 残留进程。
- `npm run build:windows:x64`：PASS，生成 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/QX影视_0.9.0_x64-setup.exe`。
- `npm run electron:smoke`：PASS，旧 Electron 构建与 smoke 保持可运行。

本轮未迁移旧 Electron 业务实现，也未读取或修改旧应用数据目录。`AppSnapshot` 已建立独立 Tauri `AppLocalData` 与 `qx-v1.sqlite3` 路径；业务模块迁移属于后续 Goal。

## Current verification addendum

- The Tauri backend is now present under `src-tauri/src`, with the versioned RPC envelope carrying `version`, `requestId`, `sessionId`, and `sequence`.
- `src-tauri/tauri.conf.json` keeps identifier `com.qx.yingshi.desktop`, NSIS packaging, and the WebView2 download bootstrapper; the latest unsigned NSIS build is 5,131,144 bytes and contains no QuickJS/mpv sidecar entry.
- G109–G111 add the later native-source, playback, and Rust-business slices without changing the legacy Electron data roots. The legacy implementation remains intentionally preserved until the final clean-install, rollback, and signed-release gates pass.
- `tmp/`, build outputs, archives, logs, and runtime data remain outside the committed Goal evidence scope.
