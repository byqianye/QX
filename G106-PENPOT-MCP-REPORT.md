# G106 Penpot MCP 迁移报告

状态：`PENPOT_FINAL_REVIEW = PASS_WITH_REPLACEMENT_PROVIDER`

本报告记录把原 G106 外部设计门禁从 Open Design Cloud 切换到 Penpot MCP 的真实接入状态。原 Open Design Cloud 的余额失败证据保留在历史报告中，不被本报告改写为 PASS。

## 当前结果

| Gate | 状态 | 证据 |
| --- | --- | --- |
| `PENPOT_MCP_PACKAGE` | `PASS` | 官方 `@penpot/mcp@2.17.0`（`next`）已通过 npm 安装并完成构建；与当前 Penpot `2.17.1` 兼容 |
| `PENPOT_PLUGIN_SERVER` | `PASS` | `http://localhost:4400/manifest.json` 返回 HTTP 200 |
| `PENPOT_MCP_HTTP` | `PASS` | `http://localhost:4401/mcp` 成功完成 MCP initialize |
| `PENPOT_TOOL_REGISTRATION` | `PASS` | MCP `tools/list` 返回官方 Penpot 工具 |
| `PENPOT_PLUGIN_CONNECTION` | `PASS` | 便携式 Chrome 中的真实 Penpot 文件已连接插件，插件显示 `Disconnect MCP Server` |
| `PENPOT_DESIGN_ARTIFACT` | `PASS` | 文件 `新建文件 1`（`3be9e5e1-190f-8090-8008-79f1441fd6b1`）包含 7 个真实 QX UI 页面和可导出的图层 |
| `PENPOT_DESIGN_SYSTEM_REVIEW` | `PASS_WITH_LIMITATION` | 本地 `--qx-*` token 基线通过；Penpot 文件 token overview 当前为空，未虚构 Penpot token 产物 |
| `PENPOT_PAGE_REVIEW` | `PASS` | Home、Search、Source Panel、Runtime、Settings、Detail、Player 七页均已导入并核验 |
| `PENPOT_FINAL_REVIEW` | `PASS_WITH_REPLACEMENT_PROVIDER` | 真实 Penpot MCP 连接、页面 artifact 和逐页审查均完成 |

## 已完成的本机接入

- Codex 全局 MCP 配置已增加 `penpot`，地址为 `http://localhost:4401/mcp`。
- 官方本地 MCP 服务当前运行在本机：MCP HTTP `4401`、插件静态服务 `4400`、WebSocket `4402`。
- 已通过真实 MCP 请求验证 initialize、工具列表和高层 API 说明。
- 已使用真实 `execute_code`、`import_image` 和 `export_shape` 调用验证当前 Penpot 文件，而不是返回 mock 设计数据。
- 设计文件中创建了 7 个页面：`QX G106 / Home`、`Search`、`Source Panel`、`Runtime`、`Settings`、`Detail`、`Player`；每页包含对应的真实本地 UI 截图图层。
- 未修改 QX 产品代码、Android Runtime、Host、Playback 或 Source Health。

## 已完成的 Penpot 连接动作

1. 使用便携式 Chrome 打开 Penpot 并复用已登录会话。
2. 创建并打开 G106 review target 文件。
3. 在 Penpot 的 Plugins 菜单从 URL 加载：
   `http://localhost:4400/manifest.json`
4. 运行 Penpot MCP 插件，点击连接，插件显示 `Disconnect MCP Server`。
5. 通过官方 MCP 导入真实 UI 证据并导出图层验证。

## 切换后的门禁

切换后的门禁结果：

```text
LOCAL_UI_IMPLEMENTATION = PASS
PENPOT_MCP_CONNECTION = PASS
PENPOT_DESIGN_SYSTEM_REVIEW = PASS_WITH_LIMITATION
PENPOT_PAGE_REVIEW = PASS
PENPOT_DESIGN_ARTIFACT = PASS
PENPOT_FINAL_REVIEW = PASS_WITH_REPLACEMENT_PROVIDER
QX_FINAL_UI_V1_WITH_PENPOT_PROVIDER = PASS
ORIGINAL_OPEN_DESIGN_CLOUD_GATE = BLOCKED (AMR_INSUFFICIENT_BALANCE, artifactCount=0)
```

原 Open Design Cloud 报告和余额失败事实保持不变；本报告只记录用户明确选择的 Penpot MCP 替代门禁，不把 Cloud 失败改写为 PASS。

## 本轮仓库回归

| 验证项 | 结果 | 备注 |
| --- | --- | --- |
| `npm test` | `PASS` | 104 个测试文件，549 个测试 |
| `npm run typecheck` | `PASS` | 无 TypeScript 错误 |
| `npm run build` | `PASS` | Electron、renderer 构建完成 |
| `npm run android-host:build` | `PASS` | Android Host Debug APK 构建完成 |
| `npm run android-host:check` | `BLOCKED` | 专用 AVD 当前未启动，明确返回 `ANDROID_DEVICE_NOT_FOUND`；没有使用外接真机或系统 adb |
| `npm run prepack-check` | `PASS` | 包内资源检查通过 |
| `npm run preview:smoke` | `PASS` | packaged Preview smoke 通过 |

Android Host 的运行态检查保持真实结果；本轮不因 G106 设计门禁而伪造 Android 设备在线。
