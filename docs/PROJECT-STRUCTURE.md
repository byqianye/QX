# 项目文件结构

更新时间：2026-09-08

文件按“运行时职责、构建职责、证据职责”分组理解。不要为了看起来整齐而移动代码；路径已经被构建脚本、Tauri 配置和测试引用。

## 运行时代码

| 路径 | 职责 |
| --- | --- |
| `renderer/src/` | Vue 3 页面、组件、主题、播放器控件、搜索状态和 Tauri renderer API |
| `src/` | TypeScript 桌面服务、配置解码、源模型、Spider 会话、播放解析、缓存和持久化 |
| `src-tauri/src/` | Rust Tauri 壳、RPC、源适配、HTTP 客户端、播放代理、窗口和 SQLite 边界 |
| `src-tauri/capabilities/` | Tauri 窗口权限；只授予实际使用的窗口 API |
| `src-tauri/quickjs-sidecar/` | Rust QuickJS 辅助工程；是否进入发行包由当前 Tauri 配置和验收证据决定 |
| `build/assets/` | 应用图标和品牌资源 |

Rust 源适配主要位于：

- 通用 HTTP：`src-tauri/src/auto_http.rs`、`legacy_http.rs`
- 声明式转换：`src-tauri/src/source_converter.rs`、`source_semantics.rs`
- 专用源：`app_get.rs`、`jianpian.rs`、`bili.rs`、`misou.rs`、`first_aid.rs`
- 会话和网络边界：`source_session.rs`
- 播放：`playback_sources.rs`、`playback_start.rs`、`playback_proxy.rs`、`playback_fallback.rs`

## 构建与安装

| 路径 | 职责 |
| --- | --- |
| `package.json` | 所有可执行脚本的唯一入口 |
| `vite.config.ts` | renderer 构建 |
| `tsconfig*.json` | TypeScript 检查和 Electron 编译 |
| `src-tauri/tauri.conf.json` | Tauri 主窗口、CSP、bundle 和 NSIS 配置 |
| `scripts/tauri-command.ts` | Tauri CLI 的 Windows 环境封装 |
| `scripts/tauri-minimal-package.ts` | 最小 Tauri NSIS 构建和构建清单 |
| `build/tauri-installer.nsh` | Tauri 安装页和可选卸载旧版本 |
| `electron-builder*.yml`、`build/installer.nsh` | Electron 兼容包路径，不是最小包路径 |

## 测试与证据

| 路径 | 职责 |
| --- | --- |
| `tests/` | Vitest、契约测试和回归测试 |
| `scripts/tauri-*.ts` | Tauri CDP、安装和真实播放验收工具 |
| `artifacts/` | 测试截图、JSON 证据和性能记录，禁止当作源配置 |
| `docs/reports/` | Goal、设计、发布和测试报告 |
| `tmp/` | 临时探针和基线，只在任务明确需要时读取，不作为发布输入 |

## 文件归属规则

- 业务行为改 `renderer/src`、`src` 或 `src-tauri/src`，并补对应测试。
- 构建行为改 `package.json`、`scripts/` 或 `src-tauri/` 配置，并更新 [BUILD.md](BUILD.md)。
- 验收结论写入 `docs/PROJECT-STATUS.md`，详细原始数据放 `artifacts/`，解释性报告放 `docs/reports/`。
- 不把 `node_modules/`、`dist/`、`release/`、`src-tauri/target/` 或临时日志提交为源文件。
- 不把 Android DEX、外部运行时、第三方源配置或凭据复制到最小 Tauri bundle。
