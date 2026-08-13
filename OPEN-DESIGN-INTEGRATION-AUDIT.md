# Open Design Integration Audit — G106-I

状态：`OPEN_DESIGN = BLOCKED`

## 集成判定

| 字段 | 结论 |
| --- | --- |
| `integrationType` | Open Design MCP → 本地 Open Design daemon → Open Design Cloud AMR agent |
| `entryPoint` | Open Design Cloud 的 `start_run` 调用 |
| `workspaceRequirement` | Cloud AMR 运行必须在已从 Personal Workspace 打开的、带工作区 scope 的项目上下文中执行 |
| `currentWorkspaceState` | Codex cwd、项目根目录和 Git repo root 均为 `C:\Users\qiany\Documents\ChatGPT\QX影视`；最新官方 Cloud run 的 `workspaceScope.source` 为 `persisted_project_binding`，workspace id 已由项目绑定提供（opaque），不再是缺失 scope |
| `failureStage` | 最新 Cloud run 已通过 workspace scope 校验，失败发生在 AMR Cloud 余额预检：`AMR_INSUFFICIENT_BALANCE` |

## 当前权威状态

历史的 `AMR_WORKSPACE_SCOPE_REQUIRED` 已被后续 workspace-scoped 项目绑定验证解决。最新官方运行记录显示：

```json
{
  "project": "qx-yingshi-g106-ui-ux-final",
  "workspaceScopeSource": "persisted_project_binding",
  "workspaceId": "present (opaque)",
  "status": "failed",
  "errorCode": "AMR_INSUFFICIENT_BALANCE",
  "failureCategory": "insufficient_balance",
  "failureDetail": "amr_insufficient_balance",
  "failureAction": "recharge",
  "artifactCount": 0
}
```

该记录证明当前调用路径和项目 workspace scope 已被接受；目前无法继续的原因是 AMR 账户余额为 0，需要外部充值后才能生成 Cloud artifact。没有把 Local Codex 结果当作 Cloud 结果，也没有伪造 artifact。

## 历史实际调用（workspace scope 阶段，已解决）

本 Goal 已按规范只正式复现一次 Cloud 调用，稳定字段如下；opaque workflow/request 标识已保留在调用链中但不写入报告：

```json
{
  "project": "qx-yingshi-g106-ui-ux-final",
  "agent": "amr",
  "requestId": "present (opaque UUID)",
  "pluginWorkflowId": "present (opaque workflow context)",
  "promptIntent": "对当前 QX 影视真实 UI 做 G106 最终设计系统与逐页设计审查；输入当前截图、--qx-* tokens、页面结构、G101-G105 冻结约束和实际实现；只报告 RELEASE_BLOCKER/POLISH/POST_V1，不重设计、不触碰 Runtime/播放链路"
}
```

实际返回：

```text
daemon 409 on http://127.0.0.1:61122/api/runs:
AMR_WORKSPACE_SCOPE_REQUIRED:
open the project from your Personal Workspace before running AMR Cloud
```

该历史错误发生在 Cloud 运行创建之前，没有 `runId`、Cloud 设计结果或可拉取 artifact。随后通过官方 workspace-scoped 项目绑定恢复了调用上下文；没有使用 Local Codex、mock 响应、伪造 workspace scope 或假设环境变量作为回退。

## 工作区与项目证据

- Codex 当前工作区：`C:\Users\qiany\Documents\ChatGPT\QX影视`。
- Git repo root：`C:/Users/qiany/Documents/ChatGPT/QX影视`。
- Open Design 项目：`QX影视 G106 UI/UX Final`。
- 项目状态：`not_started`。
- `workspaceId`：`null`。
- `get_active_context`：`active: false`，提示当前没有活动 Open Design 项目。
- 项目文件：`[]`。
- Open Design 登录状态：已登录；本次失败不是登录失败。
- Cloud 余额：`$0.0000`；本次错误明确是 workspace scope，不把余额问题冒充为根因。
- 诊断期间误带 `pluginWorkflowId` 调用过一次不支持该字段的 `get_project`，返回 `PLUGIN_CONTRACT_REJECTED`；随后已用正确的 `project` 参数复核，确认项目 `workspaceId: null`。这不是 Cloud 运行失败的根因。

## 结论与必须的用户操作

当前没有可由仓库代码、MCP 参数或本地环境安全修复的 scope。必须由用户在 Open Design Cloud 界面完成以下操作：

1. 打开 Open Design Cloud 的 Personal Workspace。
2. 在 Personal Workspace 中打开项目 `QX影视 G106 UI/UX Final`；如果项目尚未归属 Personal Workspace，将该项目绑定/移动到该 workspace。
3. 保持项目页面或项目内任一标签处于打开状态，使活动 workspace context 建立。
4. 完成后回到本 Goal，要求继续 G106-I 的最终设计审查。

在该操作完成前，继续调用 Cloud 只会重复同一个边界错误，因此本 Goal 不再重试，也不把 `OPEN_DESIGN` 标记为 PASS。

## 恢复检查（当前继续审计）

用户操作后，Open Design 的活动焦点已短暂变为：

```text
active: true
projectName: QX影视 G106 UI/UX Final
```

但 workspace scope 仍未传播到项目读写/Cloud 调用层：

- `list_projects` 返回空列表。
- `get_project`、`list_files` 和 `get_artifact` 均返回：

  ```text
  WORKSPACE_CONTEXT_REQUIRED: an explicit workspace context is required
  ```

因此当前状态不是成功绑定 Personal Workspace，而是“项目焦点已打开、显式 workspace context 仍缺失”。这次检查没有发起新的 Cloud run，也没有生成任何假 artifact。

## 用户重新打开后的恢复检查

用户重新打开项目后，活动焦点仍指向 `QX影视 G106 UI/UX Final`，但当前 daemon 的 `list_projects` 仍为空，项目读取仍不可用。按原项目 ID 调用官方 `create_project` 仅作为存在性诊断，返回：

```text
BAD_REQUEST: SqliteError: UNIQUE constraint failed: projects.id
```

这证明原项目 ID 已存在于本地数据库；它不是一个可以通过重新创建解决的缺失项目，而是被当前缺少 workspace scope 的查询层隐藏。没有创建第二个项目，也没有启动新的 Cloud run。

另外，Open Design Cloud 的网页入口在当前浏览器会话中显示邮箱登录页；MCP 的 Cloud 登录状态此前已为已登录。网页会话与 Open Design MCP 会话不是同一授权上下文，不能用浏览器登录或猜测 token 绕过项目 scope 校验。

## 外部服务阻塞判定

本轮只读检查进一步证明 workspace 绑定本身已经存在：

- 本地 SQLite 的 `workspace_projects` 记录显示目标项目的 `visibility=personal`、`resource_state=active`、`sync_state=local_only`，并存在非空的 opaque `workspace_id`。
- Open Design daemon 最新日志记录 `hub events workspace verified`，说明桌面/daemon 层已经验证该 workspace。
- 但同一 daemon 通过 Open Design MCP 的 `list_projects` 仍返回空列表，`get_project` 仍返回 `no projects on this daemon`；此前项目读写还返回 `WORKSPACE_CONTEXT_REQUIRED`。

因此当前已满足 G106-I 第 20 条的判定条件：项目 workspace 正确、Personal 可见性和 daemon 验证存在、调用入口仍是官方 Open Design MCP，但 scope 没有传播到 MCP 查询/Cloud run 层。记录：

```text
EXTERNAL_SERVICE_BLOCKER = OPEN_DESIGN_MCP_WORKSPACE_SCOPE_PROPAGATION
```

没有再次调用 `start_run`，没有注入 workspace id、没有复制 token，也没有改动 QX 产品代码。该阻塞只能由 Open Design Cloud/MCP 服务修复或重新建立一致的 workspace-scoped daemon 会话。

## MCP 注册修复（当前检查）

进一步发现 Open Design MCP 注册版本错配：

- 原注册指向 Open Design `0.18.1` 的 `daemon-cli.mjs`。
- 当前桌面应用和 workspace daemon 为 Open Design `0.19.0`。
- 已按官方签名运行时流程移除旧的 `open-design` 注册，并重新安装当前 `0.19.0` MCP 注册。
- `codex mcp get open-design --json` 现在确认 command/args 已指向 `0.19.0`。

当前 Codex 任务仍持有旧 MCP 进程快照（旧 0.18.1 MCP 进程仍在运行），因此本任务内的 MCP 工具不会热加载新注册；继续调用会误用旧 daemon。按照 Open Design skill 的边界，不能在当前任务里伪造刷新或手工注入 workspace context。需要在新的 Codex 任务中继续同一 G106 Goal，使 MCP 从更新后的注册启动。

随后已终止该明确的旧 0.18.1 MCP 子进程；当前任务的 Open Design 传输按预期关闭，0.19.0 桌面应用保持运行。新任务必须从已更新的注册重新启动连接，才能验证 Personal Workspace 和继续 Cloud 审查。

## 用户明确选择 Local Codex 后的本地审查

Cloud 因 `AMR_INSUFFICIENT_BALANCE` 无法生成 artifact 后，用户明确选择 Local Codex。Local Codex 已按同一 G106 约束对真实仓库、renderer 实现和既有 after 截图完成只读 FINAL DESIGN REVIEW。

本地审查覆盖 App Shell、Home、Search、Detail、Source Panel、Player、Runtime、Settings，未启动应用、未生成新截图、未修改产品代码，也未把本地结果声明为 Cloud PASS。审查结果和 4 项 RELEASE_BLOCKER 见：

- [OPEN-DESIGN-FINAL-REVIEW.md](C:/Users/qiany/Documents/ChatGPT/QX影视/OPEN-DESIGN-FINAL-REVIEW.md)
- [OPEN-DESIGN-DESIGN-SYSTEM-REVIEW.md](C:/Users/qiany/Documents/ChatGPT/QX影视/OPEN-DESIGN-DESIGN-SYSTEM-REVIEW.md)
- [OPEN-DESIGN-PAGE-REVIEW.md](C:/Users/qiany/Documents/ChatGPT/QX影视/OPEN-DESIGN-PAGE-REVIEW.md)

该本地路径只完成了证据化设计审查，不改变以下 Cloud 事实：

```text
OPEN_DESIGN_CLOUD_CALL = FAIL
AMR_INSUFFICIENT_BALANCE
artifactCount = 0
```

## Personal Workspace 恢复后的 Cloud 运行结果

新任务中 MCP 已恢复，且官方只读调用确认：

- `get_active_context` 可用（活动焦点当时为空，但支持显式 project）。
- `list_projects` 能看到 `QX影视 G106 UI/UX Final`。
- `get_project` 返回 `workspaceId`，项目可读写。
- `list_files` 初始为空；随后仅写入 `G106-CLOUD-FINAL-REVIEW-CONTEXT.md`，内容来自当前仓库真实 G106 文档。
- Cloud 登录状态为已登录，AMR agent 可用。

随后启动了真实的 Open Design Cloud `example-critique` 评审，目标为现有 QX UI 的 FINAL DESIGN REVIEW。运行终态为：

```text
OPEN_DESIGN_CLOUD_CALL = FAIL
errorCode = AMR_INSUFFICIENT_BALANCE
failureCategory = insufficient_balance
artifactCount = 0
```

AMR 返回账户余额不足（当前余额为 0），因此没有生成设计审查 Artifact。该结果证明此前的 `AMR_WORKSPACE_SCOPE_REQUIRED` 已解除；当前阻塞已变更为：

```text
EXTERNAL_SERVICE_BLOCKER = AMR_INSUFFICIENT_BALANCE
```

没有切换到 Local Codex，没有伪造 Cloud 结果，没有修改 QX 产品代码。恢复条件：用户在 Open Design Cloud 完成充值后，使用原始评审请求继续运行；在此之前不得宣称 Open Design 或 QX_FINAL_UI_V1 PASS。

## Local implementation after Cloud blocker

用户明确选择“用本地”后，Local Codex 初审识别的 4 项 RELEASE_BLOCKER 已在 QX 仓库中按最小范围落实，并通过新增回归、全量测试、类型检查、构建、Android Host build、prepack-check、重建预览包 smoke 和当前 NSIS 安装态检查。该本地实现只说明 QX 代码修正已验证，不产生 Open Design Cloud artifact，也不改变 `AMR_INSUFFICIENT_BALANCE` 的 Cloud 阻塞事实。
