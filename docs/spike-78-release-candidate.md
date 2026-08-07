# G78 Release Candidate 交付

状态：未完成，阻塞于 `blocked_external_clean_windows_validation` 与 `g73_open_design_review_required`。

当前已经有：pinned runtime manifest、NSIS setup artifact、portable artifact、SBOM/notices/build metadata、自动化 E2E 和二进制 hash。当前不能生成 `release_candidate_ready` 或 stable production 声明，因为 G73 视觉验收和 G76 clean Windows 矩阵仍未完成；也未执行 release commit/push。

解除阻塞后，G78 必须重新校验 installer/portable 版本一致性、setup 与 portable SHA-256、license/SBOM/runtime manifest、最终 smoke、文档限制和 clean git worktree，再创建本地 release commit；不自动 push。
