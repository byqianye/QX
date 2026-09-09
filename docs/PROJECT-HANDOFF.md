# QX影视项目接手入口

更新时间：2026-09-08

这份文档是新任务的最短接手路径。先读本文件，再按任务分支读取对应文档；项目事实以工作区中的代码、`package.json` 脚本、测试和证据文件为准。

## 先看什么

1. [AGENTS.md](../AGENTS.md)：项目规则、Goal 边界和不可破坏的工作约束。
2. [PROJECT-STATUS.md](PROJECT-STATUS.md)：唯一持续更新的任务台账、当前阻塞和验收证据。
3. [PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md)：目录职责和文件归属。
4. [BUILD.md](BUILD.md)：开发、最小 Tauri 包和 Electron 兼容包的构建路径。
5. [MAINTENANCE.md](MAINTENANCE.md)：后续任务如何修改、验证和记录。

遇到源适配问题，再读 [source-adapter-onboarding.md](source-adapter-onboarding.md) 和
[source-contract-status.md](source-contract-status.md)；遇到播放代理问题，再读
`src-tauri/src/playback_proxy.rs`、`src-tauri/src/playback_start.rs` 及对应测试。

## 项目是什么

QX影视是 Windows x64 桌面媒体播放器。用户导入自己有权访问的配置或源，应用完成搜索、详情、线路/选集、播放、收藏、历史和续播。项目不提供 DRM 绕过、不执行不受信任的远程代码、不把第三方影视源或凭据写入发行包。

运行时分三层：

- **Vue renderer**：`renderer/src`，负责页面、交互、搜索聚合、播放器 UI 和窗口栏。
- **TypeScript 桌面服务**：`src`，负责配置、状态持久化、Spider 会话、播放源解析、兼容 Electron 的服务边界。
- **Rust Tauri 适配层**：`src-tauri/src`，负责受控 HTTP、声明式转换器、AppGet/AppQi 等专用协议、播放代理、取消/超时、会话和 Tauri RPC。Rust 模块在 Tauri 主程序编译时静态链接进可执行文件，不需要单独安装 Rust。

## 当前默认工作路径

最小包使用 Tauri：

```powershell
npm ci
npm run build:windows:minimal
```

该命令需要 Windows x64、Rust/MSVC 工具链和项目要求的三个组件签名环境变量。它只构建 renderer、Rust Tauri 主程序和 NSIS，不捆绑 Electron、JRE、Python、mpv、aria2 或 Android 运行时。

开发调试：

```powershell
npm run tauri:dev
```

常规检查：

```powershell
npm run typecheck
npm run renderer:build
npm run test:source-contract
cargo test --manifest-path src-tauri/Cargo.toml
```

## 先确认的事实

- 当前 G130 仍是进行中；三类后端有短测可播证据，但尚未完成每个稳定源的电影和剧集各 10 分钟连续播放，因此不能写成“稳定源已验收”。
- 外部源会临时超时、403、404 或触发 WAF。适配正确、当前可达、真实可播是三个不同状态。
- `src-tauri/tauri.conf.json` 的 `bundle.resources` 必须保持为空；新增运行时资源会直接违反最小包目标。
- release 构建缺少组件签名环境变量时应失败，不能用伪造密钥绕过。
- 不要用 `git reset`、`git clean`、stash 或覆盖已有未提交修改。

## 接手一个新任务

先运行 `git status --short`，确认用户已有修改；再在 [PROJECT-STATUS.md](PROJECT-STATUS.md) 中登记任务和验收标准。只修改当前 Goal 需要的文件，完成后补上验证命令、证据路径、未完成事项和风险。任务结束前更新台账的“最近变更”。
