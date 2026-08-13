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
| Rust stable / Cargo | 已锁定 `rust-toolchain.toml` 为 `1.97.1-x86_64-pc-windows-msvc`；本机下载仍未完成，`rustc` 尚不可执行 |
| MSVC Build Tools | 已安装 Visual Studio 2022 Build Tools VC Tools 工作负载；常规 PowerShell 未自动加载 VS 开发环境 |
| Tauri CLI/API | 分别锁定 `2.11.4` / `2.11.1`；本机 CLI native binding 安装损坏，尚未能启动 CLI |
| `npm test` | PASS，104 个测试文件、549 个测试 |
| `npm run typecheck` | PASS |
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

## 当前阻塞

- `npm run check:rust` 会按真实 compiler 状态失败：Rustup 的 `rustc` 主包下载未完成；没有伪造 Rust PASS。
- `npm run tauri:dev -- --help` 会按真实 native binding 状态失败：`@tauri-apps/cli-win32-x64-msvc` 文件虽为 x64 PE，但 Node 加载报告无效 Win32 binary；已清理 npm cache 并强制重装仍未恢复。
- 因上述两个环境阻塞，本轮不能宣称 Tauri dev、真实 RPC、NSIS build 或退出进程验收通过。
