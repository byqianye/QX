# G108 配置、存储与 SourceCore 进度报告

状态：进行中
依赖：G107 `32ec107`

## 已完成

- Rust Tauri backend 新增 `backend_config_catalog` 版本化 RPC。
- 配置输入支持普通 JSON、`tvbox://` Base64、`**` Base64、`2423` AES-128-CBC、BOM 清理和稳定错误码。
- `AppLocalData/qx-v1.sqlite3` 建立 schema v1，保存配置源与版本摘要，不保存凭据查询参数。
- 每个源最多保留最近三个有效版本；损坏刷新回退最近有效版本。
- 前端 contracts 增加配置目录 payload/snapshot；失败响应保留请求元数据和安全错误字段。

## 验证证据

- `npm run typecheck`：通过。
- `npm run test:storage`：2 个文件、9 个测试通过。
- `npm run check:rust`：`cargo fmt --check`、`cargo check`、Rust 单元测试通过，6 个 Rust 测试通过。

## 尚未完成

- SourceSession 的 Rust 生命周期、取消/关闭和超时适配器尚未接入 Tauri backend。
- 多仓配置、HTTP trust prompt、CMS HTTP adapter 和 capability probe 尚未迁移到 Rust 控制面。
- 现有 Electron/TypeScript 实现继续保留，尚未宣称 G108 全部验收完成。
