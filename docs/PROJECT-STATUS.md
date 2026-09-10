# QX影视项目状态台账

更新时间：2026-09-10

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

### 2026-09-10：Tauri 来源切换取消链适配与测试包复验

状态：`verified`

范围：将 `/api/switch` 纳入现有 connection task，沿用 12 秒超时、请求取消和 Rust source session 清理；来源卡片选择同时透传页面的 `AbortSignal`。没有新增来源、依赖或运行时资源。

修改文件：
- `renderer/src/tauri-renderer-api.ts`
- `renderer/src/App.vue`
- `tests/tauri-renderer-api.test.ts`

验证：
- `npm run typecheck`：通过。
- `npm run test:tauri-renderer`：37 项通过；新增用例确认切换目标的 home 请求会响应取消。移除 task 透传时该用例在 1 秒内按预期失败，说明回归覆盖了原问题。
- `npx vitest run tests/v3-router.test.ts tests/cinema-ui.test.ts --reporter=dot`：51 项通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib source_session::tests -- --test-threads=1`：29 项通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib playback_proxy::tests -- --test-threads=1`：22 项通过，2 项忽略。
- `npm run tauri:test-installer`：当前代码重新构建 release NSIS 测试包。
- `QX_TAURI_TEST_E2E=1 npm run tauri:test-installer:e2e`：安装、首页、来源列表、卸载通过。
- 该安装包隔离安装后执行 `光盘 → 肥猫` 来源切换，真实 HTTP、无 mock，目标首页正常；同一安装包搜索 `花开锦绣` 后运行 `光盘 / 专线 / 第 1 集`，首帧后连续播放约 21 秒，`1920×804`，`readyState=4`。

证据：`artifacts/tauri-test-installer-e2e.json`、`artifacts/g143-guangpan-release-installed-20260910.json`。测试包：`release/test/QX影视-Test-Setup-0.9.0-rc.1-x64.exe`，SHA256 `3db33bc31baa21f591046a2cf68adaa758b49e21b659806982bedacb66239f35`，5,861,628 字节。

未完成事项和风险：光盘上游仍会轮换分片 CDN，若返回 402/502 或不在安全边界内的重定向，播放器会按现有策略安全失败并进入回退；这属于源端可用性变化，不是安装器缺少 Rust 代码。正式签名 release 仍需真实 `QX_COMPONENT_*` 环境变量，G130 稳定播放门槛仍未完成。

## G130 当前未完成门槛

- `csp_Jpys`、`csp_Gz360`、肥猫已有真实短测解码证据，但肥猫长测在约 20 秒后分片停止，尚未完成电影和剧集各 10 分钟连续播放。
- 荐片曾短测可播但首帧超过 10 秒且后续有上游超时；光盘、蔬菜等源分别受到 404、403、502 或重定向问题影响。
- 真实 release Tauri 重建需要项目签名环境变量。Debug 二进制不能替代 release 安装验收。
- 在上述门槛完成前，不把 G130 写成完成，也不生成声称验收通过的安装包。

## 最近变更

### 2026-09-09：光盘 Lirose HLS 分片重定向适配

状态：`verified`

范围：沿用现有播放代理安全边界，为光盘 AppQi 专线实际返回的 Lirose HLS 分片增加一个精确的公开 QQ TS handoff；普通跨域重定向、二次跳转、非 TS 路径和带鉴权请求头继续拒绝，没有新增源或运行时资源。

修改文件：
- `src-tauri/src/playback_proxy.rs`
- `docs/spike-21-local-proxy.md`
- `docs/source-contract-status.md`

验证：
- `cargo test --manifest-path src-tauri/Cargo.toml --lib playback_proxy::tests -- --test-threads=1`：22 项通过，2 项忽略。
- `npm run tauri:test-installer`：测试 release NSIS 构建通过。
- `QX_TAURI_TEST_E2E=1 npm run tauri:test-installer:e2e`：安装、首页、来源列表、卸载通过。
- 使用该安装包安装后的 release `qx-yingshi.exe` 执行 `光盘 / 花开锦绣 / 专线 / 第 1 集`：真实 HTTP、无 mock，首帧后连续播放 `20.381346s`，`1920×804`，`readyState=4`。

证据：`artifacts/g142-guangpan-lirose-release-installed.json`、`artifacts/tauri-test-installer-e2e.json`。测试包 SHA256：`b0f88a7e65e3456e7e3e29931a702b4d04ed034c11a20bfdc5124f0a910f7a4c`。

未完成事项和风险：上游偶尔会把同一专线分片转到其他站点并返回 402，此类响应仍会安全失败并交给现有线路回退；正式签名 release 仍需真实 `QX_COMPONENT_*` 环境变量，G130 稳定播放门槛仍未完成。

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

### 2026-09-09：Rust 源请求与播放代理适配

状态：`verified`

范围：修复环境代理返回 2xx 但响应体读取失败时的 AppQi 重试；修复 HLS/DASH 清单经过一次同源重定向后，仍以重定向前地址解析相对 URI 的问题。没有放宽代理的跨源重定向策略，也没有新增源。

修改文件：
- `src-tauri/src/app_get.rs`
- `src-tauri/src/playback_proxy.rs`

验证：
- `cargo test --manifest-path src-tauri/Cargo.toml --lib app_get::tests -- --test-threads=1`：40 项通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib playback_proxy::tests -- --test-threads=1`：21 项通过，2 项忽略。
- `npm run typecheck`、`npm run test:tauri-renderer`：通过。
- `npm run tauri:test-installer` 与 `QX_TAURI_TEST_E2E=1 npm run tauri:test-installer:e2e`：测试安装包构建、安装、首页、卸载通过。
- 新构建的 release 可执行文件运行 `光盘 / 花开锦绣 / VIP` 线路连续播放超过 20 秒；切换到 `光盘` 后首页读取成功。

证据：`artifacts/g140-guangpan-vip-release-proxy.json`、`artifacts/g141-guangpan-direct-release-proxy-after-fix.json`、`artifacts/tauri-test-installer-e2e.json`；当前测试安装包为 5,863,366 字节，SHA256 为 `f1ec60e1cee83fc5bbc955606ee4303bf3a0f898299561e46a694f88d2500a0e`。

未完成事项和风险：`光盘` 默认 `专线` 的首个 HLS 分片当前会被上游重定向到 `omts.tc.qq.com`；这一步触发既有 `PLAYBACK_REDIRECT_REJECTED` 安全边界，所以该线路仍不能播放。源接口本身可返回详情、清单和 VIP 可播线路，问题不是安装包缺少资源。`npm run test:playback` 的并发限制用例仍有既有时序抖动，单独运行该用例通过。正式签名 release 仍需真实 `QX_COMPONENT_*` 环境变量。

### 2026-09-09：定位测试安装包与打包播放差异

状态：`verified`（问题定位）

范围：对同一条 `光盘 / 花开锦绣` 播放链路分别运行测试安装包、当前 NSIS 安装包和 Debug + Vite 开发态，并用 `肥猫 / 凡人修仙传` 作为可播放对照；同时直接探测光盘 `AppQi` 搜索、详情、解析、HLS 清单和首个分片。

修改文件：
- `scripts/tauri-cdp-canary.ts`：来源切换优先按精确 key/标题选择，避免别名文本把 `光盘` 误选成其他来源。

验证：
- `光盘 / 花开锦绣` 在测试安装包、当前 NSIS 包和 Debug 开发态均出现相同的 `PLAYBACK_REDIRECT_REJECTED`，MP4 回退为 `413 Upstream response too large`，最终播放器报 `no supported source`。
- `肥猫 / 凡人修仙传` 在测试安装包、当前 NSIS 包、release 直运行和 Debug 开发态均连续播放超过 20 秒，首帧和 1920×1080 画面正常。
- 光盘接口当前返回 200；新解析出的 HLS 清单为同源 302 后 200，首个 TS 分片可在跟随上游 CDN 重定向后返回 200。应用受控代理按安全边界拒绝分片的跨源重定向，因此不是安装包资源缺失。
- 证据：`artifacts/g131-installed-test-huakai-direct.json`、`artifacts/g131-installed-current-guangpan-868710.json`、`artifacts/g131-debug-dev-guangpan-huakai.json`、`artifacts/g131-installed-test-feimao-fanren.json`、`artifacts/g131-installed-current-feimao-fanren.json`、`artifacts/g131-current-release-feimao-fanren-noproxy.json`、`artifacts/g131-debug-dev-feimao-fanren-direct.json`。

未完成事项和风险：`tauri-test-installer:e2e` 原本只验证安装、首页和来源列表，没有把第三方播放作为通过条件；光盘线路的上游重定向/短时授权仍可能变化。当前没有放宽代理的跨源重定向安全策略，也没有宣称 G130 稳定播放门槛完成。

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
