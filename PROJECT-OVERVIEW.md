# QX影视项目概览

更新日期：2026-08-19

## 项目定位

QX影视是面向 Windows x64 的桌面媒体播放器，用于播放用户有权访问的本地媒体和自有配置来源。项目不内置第三方影视源、账号凭据、DRM 绕过或托管解析服务。

当前版本为 `0.9.0-rc.1`。仓库同时保留 Tauri/Rust 主线与迁移阶段遗留的 Electron/TypeScript 实现；具体能力边界以代码、测试和对应 Goal 报告为准。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `renderer/` | Vue 桌面界面 |
| `src-tauri/` | Tauri/Rust 后端与桌面能力 |
| `src/` | TypeScript 业务模块、Electron 遗留实现与 Spike 工具 |
| `tests/` | Vitest 自动化测试 |
| `scripts/` | 构建、发布、验收和诊断脚本 |
| `fixtures/` | 稳定测试夹具 |
| `docs/` | Spike、用户、安全和来源契约文档 |
| `docs/reports/goals/` | G105 之后的 Goal 与阶段报告 |
| `docs/reports/design/` | UI、设计系统和设计审查记录 |
| `docs/reports/testing/` | 打包、播放、Windows 与 E2E 测试报告 |
| `docs/reports/audits/` | Runtime、来源健康、打包等审计记录 |
| `docs/reports/release/` | 发布说明和签名政策 |
| `artifacts/` | 机器可读的验收证据 |
| `build/`、`dist/`、`release/` | 本地构建与发布产物 |
| `tmp/` | 临时调试文件，不属于正式源码或文档 |

## 文档入口

- 使用和开发说明：[`README.md`](README.md)
- 项目执行规则：[`AGENTS.md`](AGENTS.md)
- 用户指南：[`docs/user/guide.md`](docs/user/guide.md)
- Spike 文档：`docs/spike-*.md`
- 当前 Goal 记录：`docs/reports/goals/`
- 发布签名流程：[`docs/release-signing.md`](docs/release-signing.md)
- 发布安全审查：[`docs/security/release-security-review.md`](docs/security/release-security-review.md)

## 常用验证

```powershell
npm run typecheck
npm test -- --maxWorkers=1 --minWorkers=1 --reporter=dot
```

发布、打包及真实环境验收应使用 `package.json` 中对应脚本，并遵守 Goal 报告记录的依赖和门禁。未通过 E2E、签名或外部环境验证时，不应扩大发布状态声明。

## 文件归类约定

- 根目录只放项目入口文档、包管理文件和构建配置。
- 新 Goal 报告放入 `docs/reports/goals/`。
- 人工阅读的测试结论放入 `docs/reports/testing/`，机器可读证据放入 `artifacts/`。
- 临时抓取、反编译和调试文件放入 `tmp/`，不要作为正式项目文档引用。
