# G74 发布 notices、SBOM 与构建元数据

状态：完成（材料生成范围）。依赖：G73 engineering bundle check；G73 视觉复核仍待 Open Design。

## 产物

`npm run release:inventory` 生成 `dist/release-inventory/`：

- `THIRD_PARTY_NOTICES.txt`：Temurin、CPython、mpv、aria2/OpenSSL 和 npm 依赖说明及包内 license 路径；
- `sbom.cdx.json`：CycloneDX 1.5 格式，当前锁定依赖 524 个组件；
- `runtime-manifest.json`：G70 的固定版本、归档 hash、可执行文件 hash 与 license 路径；
- `build-metadata.json`：产品、版本、Windows x64 target、git commit、Node 版本和生成时间，不写入环境变量、凭据或用户路径。

## 限制

该 SBOM 是构建期依赖清单，不代替正式发布前的漏洞扫描与许可证法务复核。G75 负责依赖审计；G76 负责 clean Windows 验证。
