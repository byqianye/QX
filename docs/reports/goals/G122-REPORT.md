# G122：Tauri 配置版本历史与激活

## 状态

完成。这个 Goal 只迁移配置版本历史与激活（回滚）到 Tauri 渲染器 API，不修改 Vue 组件、页面布局或视觉样式。

## 依赖

- Rust `backend_config_catalog` 已提供 `history` 与 `activate` 动作。
- `src-tauri/src/config_catalog.rs` 已有版本存储、激活和回退测试。
- Tauri 渲染器已经通过 `ingestConfigCatalog` 访问 Rust 配置目录。

## 范围

- 新增配置历史与版本摘要的 TypeScript 合同。
- 新增 `requestConfigCatalogMaintenance`，严格复用 `backend_config_catalog` RPC。
- 新增 `/api/import/history` 和 `/api/import/activate`。
- 激活版本后关闭旧会话，重置当前目录、播放状态和信任状态，回到配置确认页；历史、收藏、直播等非源业务状态保留。
- 新增后端接口文档和渲染器回归测试。

未做的事情：没有把 Android Runtime/DEX 伪装成可用能力，没有修改前端视觉，没有触碰 `tmp/`，也没有改变 Electron 回退边界。

## 验收标准

- 可通过 Tauri RPC 查询当前源的版本历史。
- 可通过版本哈希激活 Rust 保存的版本。
- 激活后不自动恢复信任、不自动打开播放会话、不自动发起播放请求。
- 新入口没有 HTTP 或 Electron 回退路径。

## 验证命令

```text
npm exec vitest run tests/tauri-renderer-api.test.ts
17 passed

npm run typecheck
passed
```

## 风险与未完成事项

- 配置历史和激活依赖 Rust 本地数据库；首次导入前调用历史接口会被渲染器拒绝，因为没有当前 source 上下文。
- 真正的 SignPath 签名 Release、干净 Win11 E2E 和外部签名证据仍未完成；它们不是本 Goal 的验收范围。
