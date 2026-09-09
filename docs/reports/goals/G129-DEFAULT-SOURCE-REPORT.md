# G129 默认源与完整列表修复

状态：本轮范围已完成（2026-09-06；实测于 09-05）。依赖：现有 Rust SourceSession、配置目录与 G127/G128 适配成果；G123 的未完成状态保持不变。

范围：恢复默认配置完整站点列表，测量真实源首页加载并选定固定默认源，停止启动时自动遍历选源；对实测中可明确复现的 Rust 请求失败做最小修复。

验收：旧单荐片缓存升级后恢复完整列表；默认源只打开一次；失败不偷偷切源；允许手动切换；真实 Tauri 启动、列表、首页验证通过后生成轻量测试包。

验证命令：定向 Vitest、npm run typecheck、npm run renderer:build、Rust 显式 source_benchmark canary、相关 Rust 单元测试、真实 Tauri 安装 E2E。实测与稳定夹具结果分别记录。

基线：修改前文件保存在 tmp/default-source-fix-baseline；本轮保护所有已有未提交工作。

## 结果与原因

固定选择 **光盘**。软件启动不测速、不遍历来源，也不在失败时自动替换默认源。首次启动使用内置完整配置元数据，因此不再等待配置站联网；手动导入仍可刷新远程配置。

旧版本联网失败时写入只有荐片的备用配置，随后一直恢复这份缓存。本轮只识别默认 URL 下、与旧版 key/api/ext 完全匹配的单荐片缓存，将其补回 39 项配置。其他用户配置保留原内容。

完整快照保留站点选项、解析与规则等元数据，没有嵌入远端 jar 或其他可执行文件。39 项是配置条目数，不能解读为 39 项全部可播放。

AppGet/AppQi 的只读查询在成功响应正文中途断开时，保持原方法、签名、请求体和网络路径重试一次。正文大小限制、取消和外层调用超时继续生效。未放宽鉴权或 TLS 验证。

## 真实网络测量

先用 Rust 会话链路扫描配置的 39 项，再复测候选。数据分别保存在：

- [39 项初筛](../../../artifacts/default-source-benchmark-screen.json)
- [候选复测](../../../artifacts/default-source-benchmark-finalists.json)
- [修复后首页、图片和解析测量](../../../artifacts/default-source-benchmark-repaired.json)

修复后三轮结果（本机当时网络，首页耗时不包含海报或视频首帧）：

| 来源 | 首页成功 | 成功请求耗时 | 海报抽样 | 备注 |
| --- | --- | --- | --- | --- |
| 光盘 | 3/3 | 311、340、692 ms | 9/9 有效图片 | 每次 262 条推荐；搜索和详情 3/3；播放地址解析 2/3 |
| 干饭 | 2/3 | 514、2449 ms | 5/6 有效图片 | 一次首页正文仍失败 |
| 行动 | 2/3 | 491、941 ms | 6/6 有效图片 | 一次入口发现请求失败 |
| 蔬菜 | 2/3 | 666、498 ms | 6/6 有效图片 | 一次入口发现请求失败 |

360 初筛与复测的首页响应更快，但本次解析返回需后续处理的网页地址，未作为默认影视源。选择光盘依据首页速度、推荐、海报和详情的组合结果，不宣称在所有网络下最快。

## 验证结果

- `npm run typecheck`：通过。
- `npm run renderer:build`：通过，Tauri 构建前再次执行；保留现有大 chunk 提示。
- `npx vitest run tests/tauri-renderer-api.test.ts tests/tauri-test-installer.test.ts tests/tauri-contract.test.ts tests/cinema-ui.test.ts --reporter=dot`：51/51 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib app_get::tests -- --test-threads=1`：37/37 通过。新增截断正文回归先复现失败，再修复通过。原有 Windows HTTP 夹具立即丢弃 socket 导致随机连接重置，改为 shutdown 后等待对端关闭；断言未降低。
- 显式 Rust live canary：真实请求、无 mock，失败项作为测量结果如实保留。
- 打包前真实 Tauri CDP E2E：首页有推荐、首批 5 张海报完成解码、固定光盘、来源中心 39 项；通过。
- 旧缓存升级：复制本轮隔离测试数据库，构造旧版单荐片配置与记忆选项后重新启动；恢复 39 项并固定光盘；通过。没有修改用户真实数据库。
- 安装 E2E：安装退出 0、安装后的首页/海报/39 项列表验证退出 0、卸载退出 0、安装目录移除；通过。
- 安装目录额外运行时检查：未发现 Electron、Node、JVM/jar、Android/APK/DEX、Python、mpv、aria2、QuickJS sidecar。

本轮未重跑完整 Vitest，也未声称全套通过。前序完整运行存在 JVM/Python/发布签名等环境失败。

## 安装包与截图

- [测试安装包 fix3](../../../release/test/QX影视-Test-Setup-0.9.0-rc.1-fix3-x64.exe)：5,817,108 字节（5.82 MB / 5.55 MiB）。
- SHA256：`144446a1a0176c5b5faf833d2ab6f3a1458319cc06cbb74617087c6b5dedb133`
- [安装验证报告](../../../artifacts/g129-test-installer-e2e.json)
- [安装后首页](../../../artifacts/g129-installed/home.png)
- [安装后来源列表](../../../artifacts/g129-installed/sources.png)
- [旧缓存升级首页](../../../artifacts/g129-legacy-upgrade/home.png)
- [旧缓存升级日志](../../../artifacts/g129-legacy-upgrade.log)

## 本轮修改文件

- `renderer/src/default-source.ts`、新增 `renderer/src/default-source-catalog.ts`：固定默认与完整配置快照。
- `renderer/src/tauri-renderer-api.ts`：本地引导、旧缓存修复、固定源一次请求、失败后的手动切换。
- `renderer/src/App.vue`：启动引导参数，移除第二次选源。
- `renderer/src/CoreShell.vue`：暴露当前源 key 与条目数，供 E2E 严格检查。
- `src-tauri/src/app_get.rs`：正文重试与真实 TCP 回归夹具。
- `src-tauri/src/lib.rs`、新增 `src-tauri/src/source_benchmark.rs`：仅测试编译的真实网络测量入口。
- `tests/tauri-renderer-api.test.ts`、`tests/tauri-test-installer.test.ts`：完整列表、旧缓存、固定默认、不自动故障转移及手动恢复回归。
- `scripts/tauri-cdp-canary.ts`、`scripts/tauri-test-installer-e2e.ts`：严格默认源/海报/列表断言、截图与额外运行时检查。
- 本报告及相关 artifacts；`tmp/` 保留基线和一次性数据生成工具。

## 未完成事项与风险

- 光盘播放器解析仍出现一次上游失败；本轮未验证真实视频首帧，不宣称实际播放全通过。
- 其他源的离线、登录、缺少协议合同或外部脚本运行时问题没有被这次通用传输修复覆盖。
- 配置与推荐由上游维护，快照可能随时间过期；可通过来源中心重新导入该 URL 更新。
- 最小包依赖系统 WebView2；缺失时沿用安装器的下载引导，不内嵌完整 WebView2。
- 没有自动 push 或发布，已有未提交改动保留。
