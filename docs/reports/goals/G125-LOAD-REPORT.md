# G125 加载性能优化报告

状态：已完成（第一阶段）

范围：渲染器请求层的重复请求合并。对同一路径与相同请求体的并发请求复用同一个在途 Promise，请求结束后自动清理；Tauri RPC 路径保持原行为。

修改：
- renderer/src/api.ts：增加 in-flight 请求去重，覆盖 getState 与 HTTP post。

验证：
- npm run typecheck：通过
- npm exec vitest run tests/tauri-renderer-api.test.ts -- --maxWorkers=1 --minWorkers=1 --reporter=dot：25 项通过
- 完整 Vitest：613 项通过，1 项失败（既有 AdGuard/代理改写 CSP，基线同样失败）。

未完成：配置下载、解析、会话初始化、首页、搜索、详情、媒体解析的真实耗时基线仍需在不同网络环境分别采集；新源适配效率属于后续独立 Goal。

风险：请求去重只合并完全相同的并发请求，不改变请求取消、超时或源协议；无法消除外部上游本身的网络延迟。
