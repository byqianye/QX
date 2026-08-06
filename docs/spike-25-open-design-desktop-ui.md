# Spike 25：Open Design 正式桌面 UI

## 状态

G26 当前标记为 `blocked_open_design_unavailable`。本次已确认 Open Design MCP 工具声明存在，但实际 transport 不可用；以下调用均返回 `Transport closed`：

- `get_active_context`
- `list_projects`
- `list_agents`
- `list_skills`
- `list_plugins`

因此没有启动 Open Design run，也没有生成或伪造设计方向、Token、截图、组件规格或 implementation handoff。G25 Vue renderer 保持为当前可用 UI。

## 阻塞决策

根据 G26 情况 3：

- 标记 `blocked_open_design_unavailable`；
- 不使用普通 AI 或自行写 CSS 代替 Open Design；
- 不继续 G27–G29；
- Open Design transport 恢复后，从 G26-A 重新检查能力，再生成唯一最终设计方向。

## 保留内容

G25 的 Vue renderer、既有 API/错误码、LocalProxy、播放器合同和打包 E2E 不受此阻塞影响。未创建 `docs/design/open-design/` 设计产物目录，以避免把非 Open Design 内容误标为正式设计。

## 解锁条件

需要 Open Design MCP transport 恢复，且至少能够读取项目/能力上下文并成功启动一个 design run。解锁后必须按目标要求覆盖主框架、导入/信任、浏览、详情、线路/选集、播放器、加载/错误/空状态、设置、主题、窗口尺寸和设计系统状态。
