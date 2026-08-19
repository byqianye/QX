# Stage 1 收口附录（G104–G106）

状态：已记录，作为 G107 的输入基线。

## 收口成果

- G104 / G105：在隔离的 Windows 11 验收环境完成 Android Runtime、真实 `csp_Jianpian` 搜索→详情→播放地址→LocalProxy→HLS 播放证据；G105 最终报告记录 104 个测试文件、545 个测试通过。
- G106：完成本地 UI 实现、回归测试和 packaged smoke；Open Design Cloud 因 `AMR_INSUFFICIENT_BALANCE` 无 artifact，继续标记为外部阻塞，不扩大为 Cloud PASS。
- 当前工作区基线复验：`npm test` 通过 104 个测试文件、549 个测试；`npm run typecheck` 通过。

## 工作区处理

- G107 使用本地分支 `codex/g107-tauri-baseline`。
- Stage 1 筛选基线提交为 `5de04df`，本地标签为 `stage1-g106-final`。
- 基线提交只纳入源码、测试、文档和配置；EXE、ZIP、`tmp/`、解包目录和 `qx-extracted-bootstrapper.js` 未纳入，仍保留在工作区供人工处理。
- 未执行破坏性清理；未修改旧 Electron 数据目录，也未自动 push。

## 已知限制

- G104/G105 的 Android Runtime 证据不迁移为 Tauri 原生能力承诺；Stage 2 必须重新实现并逐项验收。
- G106 Cloud 设计审查仍被外部余额阻塞。
- G107 之前项目没有 Rust/Tauri 工具链，也没有 `src-tauri`。

## G106→Stage 2 边界

G107 只建立 Tauri 壳、独立数据路径、版本化 contracts 和一条真实 RPC；不迁移旧 Electron 业务实现，不读取旧数据库，不执行 DEX/JAR/Python/JVM，不改变旧应用数据目录。G108 以后才逐步迁移配置、来源、播放和业务能力。
