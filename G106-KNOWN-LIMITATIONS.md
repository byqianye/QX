# G106 Known Limitations

- Open Design Cloud 的 workspace scope 阻塞已解除：新任务可以读取 Personal Workspace 项目并启动 Cloud 调用。
- 最新 Cloud 设计委托因 `AMR_INSUFFICIENT_BALANCE` 失败，未生成可拉取的 Cloud 产物；需要完成 AMR 账户充值后继续原始评审请求。详见 [OPEN-DESIGN-INTEGRATION-AUDIT.md](C:/Users/qiany/Documents/ChatGPT/QX影视/OPEN-DESIGN-INTEGRATION-AUDIT.md)。
- 当前 preview packaged smoke 已通过，`localMediaRestart` 为 true；真实 Jianpian Clean Windows Android E2E 依赖 G105 已通过证据，本轮没有重复启动外接真机。
- 本轮没有生成 Installer 专用截图；Installer 的安装/启动/卸载 E2E 已通过，也没有把 packaged fixture 结果扩大解释为新的 Jianpian 能力声明。
- 2560x1440、真实 Jianpian 详情/46 集以及 Installer 级截图需要在 packaged smoke 回归恢复后补做。
- 用户明确选择 Local Codex 后，已完成只读本地 FINAL DESIGN REVIEW；本地报告见 [OPEN-DESIGN-FINAL-REVIEW.md](C:/Users/qiany/Documents/ChatGPT/QX影视/OPEN-DESIGN-FINAL-REVIEW.md)。该结果不能替代 Open Design Cloud artifact。
- Local Codex 识别的 4 项 RELEASE_BLOCKER 已按最小范围实施并通过回归：Detail 上下文、Search 空态动作、Source Panel site name、ConfirmDialog 焦点安全。该本地实现不替代 Cloud artifact；Cloud 仍因 `AMR_INSUFFICIENT_BALANCE` 阻塞。
