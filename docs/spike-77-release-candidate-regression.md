# G77 Release Candidate 回归矩阵

状态：`RC_READY=true`（物理 Windows local clean-room 范围）。依赖：G76 `passed_local_windows_clean_room`。

本机 RC 矩阵已跑通完整 fixture 场景，包含 G61 EPG continuity、G69 backup、进程清理、数据重启与下载 metadata。G76 安装包 E2E 的下载步骤使用真实 bundled aria2，真实 bundled Python/mpv/aria2 smoke、bundled JRE negative check、网络超时、性能 probe 和安装器 E2E 均通过。

packaged E2E 仍保留 fake mpv exit probe 作为确定性故障合同；真实 mpv smoke 单独从安装目录执行并纳入同一 RC 记录。skip 扫描只发现已有的 Java/Python 可用性条件分支，没有 `.only` 或未记录的发布跳过。该状态只表示物理 Windows local clean-room RC，不表示 pristine OS 或 stable production。
