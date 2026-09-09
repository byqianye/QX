# QX影视 Preview Release Notes

版本：0.1.0 Preview V1
日期：2026-08-09

## 包含内容

- Windows x64 unpacked、NSIS installer、Portable 三种测试产物；
- Rust native HTTP adapters for the verified sources;
- 现有本地媒体、设置、历史、缓存和受控播放测试能力保持可用。

## 已知限制

- Android DEX/JAR sources are diagnostic-only and are not executable by this desktop build;
- 当前包未签名（`SIGNED=false`），不包含自动更新；
- Packaging and clean Windows E2E must be rerun after the runtime cleanup;
- 外部影视源、用户 token、解析服务和第三方网络可用性不由本 Preview 保证；不内置凭据。
