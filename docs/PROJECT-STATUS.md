# QX影视项目状态台账

更新时间：2026-09-09

这是项目唯一持续更新的状态文档。新对话先读这里；每次任务完成、阻塞或放弃都追加记录。

## 当前结论

| 项目 | 状态 | 依据 |
| --- | --- | --- |
| Vue 深色影院 UI、播放器和自定义窗口栏 | `verified`（代码/专项回归） | `docs/reports/goals/G124-UI-REPORT.md`、`tests/cinema-ui.test.ts`、`tests/window-titlebar.test.ts` |
| 加载调度和多源渐进搜索 | `verified`（代码/专项回归） | `docs/reports/goals/G125-LOAD-REPORT.md`、`tests/aggregate-search.test.ts` |
| 声明式/Rust 源适配基础 | `verified`（合同范围） | `docs/reports/goals/G126-SOURCE-ADAPTER-REPORT.md`、`npm run test:source-contract` |
| 肥猫通用适配 | `verified`（适配边界） | `docs/reports/goals/G127-FEIMAO-SOURCE-AUDIT.md`、`docs/source-contract-feimao-generic.md` |
| 默认源固定 | `verified`（配置路径） | `docs/reports/goals/G129-DEFAULT-SOURCE-REPORT.md` |
| G130 三个独立稳定源和十分钟连续播放 | `in_progress` | `docs/reports/goals/G130-STABLE-PLAYBACK-REPORT.md` |
| 最小 Tauri 安装包 | `blocked`（release 环境门禁） | 缺少 `QX_COMPONENT_PUBLIC_KEY_BASE64`、`QX_COMPONENT_MANIFEST_URL`、`QX_COMPONENT_SIGNATURE_URL` |

## G130 当前未完成门槛

- `csp_Jpys`、`csp_Gz360`、肥猫已有真实短测解码证据，但肥猫长测在约 20 秒后分片停止，尚未完成电影和剧集各 10 分钟连续播放。
- 荐片曾短测可播但首帧超过 10 秒且后续有上游超时；光盘、蔬菜等源分别受到 404、403、502 或重定向问题影响。
- 真实 release Tauri 重建需要项目签名环境变量。Debug 二进制不能替代 release 安装验收。
- 在上述门槛完成前，不把 G130 写成完成，也不生成声称验收通过的安装包。

## 最近变更

### 2026-09-09：按用户要求构建当前工作区测试安装包

状态：`verified`

依赖：当前工作区、现有 Tauri 测试包脚本、Windows x64 Rust/MSVC 与 WebView2。

范围：沿用 `tauri:test-installer` 的测试组件配置，构建带日期的轻量 NSIS 测试包；保留旧包和用户未提交修改。本项为 G130 期间的测试交付，不改变 G130 稳定播放验收状态。

验收标准：当前代码类型检查和相关回归通过；当前编译产物先通过真实桌面 E2E 再打包；安装包完成隔离安装、首页与来源列表验证、卸载和进程退出检查；记录大小、SHA256 与证据。

验证命令：`npm run typecheck`（通过）；`npx vitest run tests/tauri-packaging-config.test.ts tests/tauri-test-installer.test.ts tests/tauri-contract.test.ts tests/tauri-renderer-api.test.ts tests/playback-recovery.test.ts tests/window-titlebar.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot`（57 项通过）；`npm run test:source-contract`（2 项通过）；测试配置下 Tauri release NSIS 构建（通过）；`npm run tauri:test-installer:e2e`（通过）。

生成文件：
- `release/test/QX影视-Test-Setup-0.9.0-rc.1-20260909-x64.exe`（5,870,329 字节）
- `artifacts/tauri-test-installer-e2e-20260909.json`

证据：安装退出码 0；首页推荐 262 条；首批海报解码成功；固定来源为 `光盘`；来源数量 39；CDP 验收退出码 0；卸载退出码 0；安装目录已移除；额外运行时扫描为空。SHA256：`bc29abce56eca22c3c30f8b00b1d428812cb491c286d37881731bc906ddc385a`。

未完成事项和风险：该包使用测试组件地址和自动导入 preset，只用于本机安装流程回归，不是正式签名发布包；G130 三源电影/剧集各十分钟稳定播放仍未完成。

### 2026-09-08：项目整理与最小包路径

状态：`in_progress`

已完成：

- 增加项目接手入口、目录职责、构建说明和维护规则。
- 增加 `docs/README.md` 作为文档索引。
- 建立本文件作为唯一持续状态台账。
- 增加 `build:windows:minimal`，固定 Tauri Windows x64 NSIS 路径；Rust 适配层随 Tauri release 可执行文件静态编译。
- 明确 Electron bundled runtime 路径不属于最小包。

待验证：

- 取得真实组件签名环境变量后运行最小 Tauri release 构建。
- 生成安装器后执行安装、配置恢复、卸载旧版本选项和退出清理 E2E。

本次已验证：

- `npm run typecheck`：通过。
- `npx vitest run tests/tauri-packaging-config.test.ts tests/tauri-test-installer.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot`：10 项通过。
- `npm run test:source-contract`：2 项合同检查通过。
- `npm run renderer:build`：通过；Vite 报告 HLS/Shaka 大 chunk 警告，未改变播放器依赖。
- `npx tsx scripts/tauri-minimal-package.ts`：按预期在缺少 `QX_COMPONENT_PUBLIC_KEY_BASE64` 时停止，未生成不可信 release 包。

## 记录模板

复制以下模板追加到“最近变更”顶部：

```markdown
### YYYY-MM-DD：任务名称

状态：`in_progress` / `verified` / `blocked` / `abandoned`

范围：...

修改文件：
- `path/to/file`

验证：
- `command`：通过 / 失败（原因）

证据：`artifacts/...`、`docs/reports/...`

未完成事项和风险：...
```

## 相关入口

- [项目接手入口](PROJECT-HANDOFF.md)
- [文件结构](PROJECT-STRUCTURE.md)
- [构建与打包](BUILD.md)
- [维护规则](MAINTENANCE.md)
- [G130 稳定播放报告](reports/goals/G130-STABLE-PLAYBACK-REPORT.md)
