# G77 Release Candidate 回归矩阵

状态：`blocked_external_clean_windows_validation`。依赖：G76。

本地 packaged first/restart E2E 已成功跑通完整 fixture 矩阵，包含 G61 EPG continuity、G69 backup、进程清理、数据重启与下载 metadata；G70/G71 的真实 mpv/aria2 smoke 也已通过。

但这还不是 G77 的 RC_READY：packaged E2E 的媒体/下载主流程使用既有 fake fixture 开关，且 G76 的 clean Windows 安装、升级、卸载和宿主机 runtime 缺失矩阵尚未执行。因此不能隐藏 skip、不能把本机环境结果提升为 RC 结论。
