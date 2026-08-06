# G20 验证报告

## 1. Goal

Goal：建立 Codex 目标模式工程治理体系，并生成可供外部审查的验证包。

## 2. 最终状态

完成。

已完成治理文档、基线识别、方案文档状态更新、完整测试、Windows 打包和打包版 E2E。方案原文从 WorkBuddy 修改备份对应的工作区文件中确认后，只更新了状态行，没有重写方案内容。

## 3. 修改文件列表

业务范围内的修改：

- AGENTS.md：新增 Codex Goal 开发规范。
- docs/CODEX_GOALS.md：新增 Stage 0/Stage 1 状态、G20 范围、G21–G78 路线、DEX-1 至 DEX-5 支线和基线命令。
- E:/Codex/Work/WorkBuddyWorkspace/2026-08-05-20-26-14/FongMi桌面端重构方案.md：只更新方案状态为进入 Codex Goal 驱动执行阶段，并增加当前由 Codex 目标模式推进实现的说明。

本验证包新增：

- verification/G20/G20-report.md
- verification/G20/G20-test-log.txt
- verification/G20/G20-diff-stat.txt
- verification/G20/G20-status.txt
- verification/G20/G20.patch

没有修改 src、fixtures、tests、package.json、package-lock.json、Spider、Player 或 Proxy。

## 4. 实际实现内容

- 写入 AGENTS.md 中指定的修改原则、Spider/引擎边界、测试规则、构建发布规则、Goal 输出规则和当前阶段。
- 写入 CODEX_GOALS.md 中指定的 Stage 0 已完成、Stage 1 进行中、G20 进行中、G21–G78 未开始和 DEX 实验支线。
- 记录标准基线命令，并明确 package.json 当前没有 electron:e2e，实际打包 E2E 脚本是 electron:e2e:package。
- 在方案原文中把“方案已定稿，待开工”更新为“方案已定稿，进入 Codex Goal 驱动执行阶段（G20 起始）”，并保留原有版本、章节和决策内容。
- 生成未提交的外部审查文件和非空补丁。G20.patch 大小为 3880 字节，补丁不包含 verification 目录自身。

## 5. 未实现内容

- 无。Goal 范围内的文档、验证和状态更新均已完成。
- 没有新增 electron:e2e 别名，因为这会扩大本 Goal 的修改范围；使用现有 electron:e2e:package 完成等价验证。

## 6. 架构或调用链变化

没有架构或业务调用链变化。本 Goal 只修改治理文档。

验证时覆盖的既有链路为：

Electron 打包程序 → DesktopSpiderUiServer → DesktopSpiderImportController → DesktopSpiderSession → DesktopSpiderClient → JvmSidecar → java.exe。

## 7. 使用的 fixture

- Vitest 使用仓库已有的 fixtures/jvm 和 fixtures/spiders，以及测试内置的本地 HTTP server。
- JVM player 测试使用已有的 csp_PlayableFixture；它是受控 fixture，不代表第三方影视源能力。
- 打包 E2E 使用已有的 csp_Douban.jvm.jar 配置、临时本地配置 server 和现有默认 Douban endpoint。外部 endpoint 的 URL、API key 和任何私有播放地址均未写入本验证包。
- 本 Goal 没有新增或修改 fixture。

## 8. 验证命令、退出码与结果

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| git status --short | 0 | 通过；结果见 G20-status.txt |
| git diff --stat | 0 | 通过；治理文档 2 个文件、127 行新增，结果见 G20-diff-stat.txt |
| git diff --check | 0 | 通过；只有 Git 的 LF/CRLF 提示，没有 whitespace error |
| npm run typecheck | 0 | 通过 |
| npm test | 0 | 12 个测试文件通过，55/55 tests passed |
| npm run electron:e2e | 1 | 真实执行失败：package.json 未定义该 script；没有伪造结果 |
| npm run electron:package:win | 0 | Windows x64 Electron 包构建通过 |
| npm run electron:e2e:package | 0 | 打包版 E2E 通过，作为实际脚本对应项 |

## 9. 打包版 E2E 结果

两轮运行均 status=passed，9/9 checks 全部为 true：

- initialImportForm
- urlImport
- cancellation
- fileImport
- jsonImport
- searchDetail
- sidecarStopped
- repeatedStart
- trustedReimport

两轮 searchVodId 和 detailVodId 都是 msearch:36246195，保持一致。

## 10. 生命周期和进程清理

两轮打包 E2E 都验证了窗口关闭后的 sidecarStopped=true。此次运行记录的 sidecar PID 为 77732 和 40164，均通过 waitForSidecarExit 检查。现有测试还覆盖超时终止、destroy 后不再运行和 Electron shell 关闭只清理一次。

## 11. 已知限制

- canonical 命令 electron:e2e 不存在，必须使用 electron:e2e:package。
- 打包使用了已有的 development-fallback Oracle JDK 21.0.7+8-LTS-245，没有使用 Spike 18 要求的 pinned Temurin；因此验证通过不等于发布资产已达到固定工具链要求。
- 方案文档位于当前 Git 仓库之外，G20.patch 按要求只反映当前 Git 仓库内的 AGENTS.md 和 docs/CODEX_GOALS.md；外部方案文档的实际修改路径已在本报告和工作区记录。
- 当前验证包文件未 commit，不包含验证包自身。

## 12. 安全风险

- 现有 Spider 导入流程仍会在用户确认信任后执行远程 Spider 代码；本 Goal 没有新增安全边界。
- 打包 E2E 会按现有代码访问默认 Douban endpoint；报告和日志已脱敏，不包含 Authorization、Cookie、Token、API key、用户本地账号路径或私有播放 URL。
- 现有 JVM sidecar 是进程隔离，不等同于完整 Windows 安全沙箱；这是既有边界，不是本 Goal 新增风险。

## 13. 与 Goal 原范围的偏差

- 按新增要求生成了 verification/G20 外部审查包。
- 方案文档位于当前 Git 仓库之外，因此状态更新不出现在当前仓库的 git diff 中；但已按原文完成最小修改。
- 未添加 electron:e2e 别名，避免无关 package.json 变化；实际脚本已执行并通过。

## 14. 建议 commit message

chore: initialize Codex goal system (G20)

- add AGENTS.md with development rules
- add CODEX_GOALS.md with G20–G78 roadmap
- align Spike 0–19 status
- update project phase to Stage 1 (G20+)
- no functional changes

本次不 commit、不 push，等待人工审查。
