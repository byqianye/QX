# G78 Release Candidate 交付

状态：`release_candidate_ready`（物理 Windows local clean-room 范围；未宣称 stable production）。

当前已经有：pinned runtime manifest、NSIS setup artifact、portable artifact、SBOM/notices/build metadata、自动化 E2E、真实 bundled runtime smoke、G76 local clean-room 报告、G77 `RC_READY=true` 和二进制 hash。G73 已按用户授权的仓库侧自审完成；不宣称 stable production。

G78 已重新校验 installer 版本/hash、license/SBOM/runtime manifest、最终 Setup smoke、用户文档和已知限制，并创建本地 release commit；不自动 push。portable 目录仍不是最终 ZIP 交付物。
