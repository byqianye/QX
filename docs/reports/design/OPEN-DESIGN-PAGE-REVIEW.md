# QX影视 G106 Page Review

审查来源：`Local Codex / Open Design critique skill`  
审查状态：`LOCAL_CODEX_REVIEW = PASS`；Open Design Cloud 仍为 `BLOCKED`。

| 页面/区域 | KEEP | 最小修正 | 等级 |
| --- | --- | --- | --- |
| App Shell | 窄导航、sticky 搜索、最大内容宽度、来源摘要 | Search / Detail 时补 Browse 子状态 selected 视觉 | POLISH |
| Home | Media Card、媒体网格、Loading / Empty / Error 边界 | 空态动作不应无条件回 Home | LOCAL_FIX_APPLIED |
| Search | 查询词保留、错误状态可重试 | 空结果、清筛保留 query 和列表上下文；无能力时隐藏占位筛选 | LOCAL_FIX_APPLIED |
| Detail | 字段、线路、来源、播放 CTA 顺序合理 | 关闭回原上下文；抽屉滚动后仍在当前视口 | LOCAL_FIX_APPLIED |
| Source Panel | 连接中、准备中、确认、不可用状态齐全 | 不展示 `inline:<id>` 等内部 source key | LOCAL_FIX_APPLIED |
| Player | 线路、集数、HLS/MP4、错误恢复、独立窗口边界存在 | 只保留一套控制条，不改播放链路 | POLISH |
| Runtime | 状态、安装、修复、重启、卸载路径齐全 | READY、毫秒、Host/RPC 术语降级到诊断区 | POLISH |
| Settings | 来源、主题、Runtime、诊断、隐私、缓存、存储、备份分组齐全 | 分组层级和 Backup / Storage / Cache 文案收口 | POLISH |

## 最小发布修正集合（已落实）

1. Detail 返回原 Search / Category 上下文，并保证抽屉当前视口可见。
2. Search 空结果、清筛和无筛选能力状态不再静默回 Home。
3. Source Panel 只显示 site name / 状态，不显示内部 source key。
4. ConfirmDialog 完成焦点移入、Tab 循环、Escape 取消和关闭后恢复。

本地验证覆盖 Detail 返回上下文、Search 空态动作、site name 展示和 ConfirmDialog 键盘焦点；全量 `npm test`、`npm run typecheck`、`npm run build`、`npm run android-host:build`、`npm run prepack-check` 以及当前重建包 `npm run preview:smoke` 均通过。NSIS 当前预览安装态也已通过安装、启动、卸载和用户数据保留检查。

## 验证建议

从首屏和已滚动网格分别打开详情并关闭；验证查询、空态、来源展示和危险确认框键盘流。Cloud 余额恢复后，仍需按 G106 Final gate 重新执行真实 Cloud 评审，不能用本地报告替代 Cloud artifact。
