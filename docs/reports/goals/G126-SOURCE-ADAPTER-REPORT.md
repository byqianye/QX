# G126 新源适配效率报告

状态：已完成

改动：
- 新增 `scripts/source-contract-check.ts`，统一运行声明式转换器 TypeScript 合同测试与 Rust 转换器测试，并生成 `artifacts/source-contract-check.json`。
- `package.json` 新增 `npm run test:source-contract`。
- 新增 `docs/source-adapter-onboarding.md`，明确普通 JSON HTTP 源最短接入路径、五阶段验收和专用适配器边界。

验证：
- `npm run test:source-contract`：通过，2 个检查通过。
- 产物：`artifacts/source-contract-check.json`。

未完成：真实上游源的读取、搜索、详情、媒体解析、实际播放仍需逐源执行 canary；动态签名、加密、HTML、登录和脚本源不自动转换。

风险：脚本使用现有固定合同测试，不把配置可导入等同于线上可播放；真实源可能因 WAF、TLS、登录或内容变化失败。
