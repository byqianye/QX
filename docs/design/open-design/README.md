# QX 影视 Open Design 归档

本目录归档一次实际成功的 Open Design 设计运行结果，并记录它与 G26 实现的对应关系。

- 设计方向：安静的桌面工作台（quiet desktop workbench）
- 视觉系统：Neutral Modern；浅灰工作区、白色内容面、单一 cobalt accent
- 技术边界：Electron + Vue 3 + TypeScript；renderer 只消费 typed IPC，不持有凭据、不直连第三方服务
- 覆盖任务：来源导入与信任、浏览/搜索/筛选、详情抽屉、线路/选集、MP4/HLS 播放、代理与不可用错误恢复、设置与诊断
- 验收尺寸：1280×720、1440×900、1920×1080

校正后的 UTF-8 Open Design run 返回成功，内部审查由 5 位评审完成，分数为 8.4–8.8，均为 `MUST_FIX=none`，最终 `ship_ready=true`。此次运行没有产生 HTML/SVG 原型，仓库也没有可信参考截图；因此 `screenshots/README.md` 明确记录为空，`assets/README.md` 明确记录不使用外部素材。

截图中另有一条旧的 Open Design agent run 显示 `AGENT_EXECUTION_FAILED`；它不是本次校正 run，且没有被用作 G26 设计证据。Open Design 的状态 UI 仍会把部分已保存的 prompt 展示成 `?`，但校正 run 生成的中文设计文件已按 UTF-8 正确落盘；仓库以生成文件和成功状态作为可复核证据。

## 文件映射

`design-brief.md`、`design-system.md`、`page-specs.md`、`component-specs.md`、`interaction-specs.md` 和 `implementation-handoff.md` 是校正后的 Open Design 输出按项目命名整理后的实现归档。Open Design 原始文件名为 `DESIGN.md`、`design-contract.md`、`component-spec.md`、`page-spec.md` 和 `interaction-spec.md`；仓库使用目标要求的复数文件名保存实现交接版本。

实现入口在 `renderer/src/SpiderView.vue`；组件名与本目录的 18 个组件规格保持一致。真实 API、Spider、Proxy、播放器和 Jellyfin 合同仍由既有类型与服务层负责，本目录不扩展第三方能力声明。
