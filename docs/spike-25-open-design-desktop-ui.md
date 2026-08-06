# Spike 25：Open Design 正式桌面 UI

## 状态

G26-A 已解除并完成：Open Design transport 已实际握手，项目、能力上下文和设计 run 均可调用。校正后的 UTF-8 设计运行生成了唯一方向“安静的桌面工作台（quiet desktop workbench）”；5 位评审均为 `MUST_FIX=none`，最终 `ship_ready=true`。

Open Design 生成了设计系统、页面规格、组件规格、交互规格、实现交接和设计合同；没有生成 HTML/SVG 原型，也没有可信截图。仓库不伪造这两类证据，真实产物按实现所需文件名归档在 `docs/design/open-design/`。

## 设计结论

- Neutral Modern：`--bg` 浅灰工作区、`--surface` 白色内容面、单一 cobalt `--accent`。
- Windows 桌面工作台：232/248px 侧栏、64px 顶栏、24px gutter、右侧详情抽屉。
- 组件覆盖来源、搜索、分类/筛选、媒体网格、详情、线路/选集、播放器、错误恢复、信任、设置和诊断。
- 明确区分 `Proxy Required` 与 `Playback Unavailable`，均提供可恢复动作。
- 不使用外部图片 CDN、渐变、玻璃拟态、虚构指标或 emoji 功能图标。

## 证据与后续

Open Design 设计运行记录和内部审查结论已用于 G26 实现。截图中另有一条旧 run 显示 `AGENT_EXECUTION_FAILED`，不作为本次证据；校正 run 返回退出码 0。项目验证命令、完整测试、响应式规则检查和 packaged E2E 已通过，G26 checkpoint 固化本次实现。G27–G29 尚未启动，真实 Jellyfin 鉴权/播放仍需外部凭据，未在本地冒充验证。
