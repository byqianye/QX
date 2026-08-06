# Spike 28：统一错误、诊断和恢复界面

## 状态

G29 已完成。错误在 renderer 边界统一映射为 `AppError`；原始错误码保留，用户消息和复制诊断经过同一套脱敏器处理。

## AppError 合同

`renderer/src/state.ts` 定义：

```text
AppError {
  code
  title
  message
  source
  retryable
  diagnosticId
  timestamp
  safeDetails
  causeCode?
}
```

后端已有的 `{ code, message }` 错误不会被伪装成成功；`renderer/src/error.ts` 按错误码前缀和主要错误码映射来源、标题和恢复策略。未知码保留原码，落到通用 renderer 错误，不统一改写成“网络错误”。

覆盖的错误族包括配置导入/解析/信任、Spider/RPC/超时、搜索/详情、`playerContent`、播放不可用/格式错误/Proxy、Proxy 上游与超时、HTMLVideoElement、HLS、Java 运行时、Electron/UI server、持久化和资源清理。

## 展示与恢复

- `ErrorState` 显示简明标题、用户说明、原错误码和建议操作；
- `retryable=false` 时不显示无意义的重试按钮；不可重试的播放错误保留切换线路、返回和设置入口；
- App 记录最近一个可重放操作，重试成功/失败后保留原错误码；
- 导入错误也使用同一错误卡，输入框仍可继续导入；
- `AppErrorDetails` 展示 `code`、`diagnosticId`、`source`、`timestamp`、`causeCode` 和安全详情，并提供复制诊断；
- HTMLVideoElement/HLS 运行时错误通过 `/api/player/sync` 进入同一错误流，保留 `HTML_VIDEO_ERROR`、`HTML_VIDEO_PLAY_ERROR` 或 `HLS_ERROR`。

## 脱敏边界

复制内容调用与界面相同的 `formatDiagnostic`：

- Authorization、Cookie、token、API Key、密码和 secret 的值被替换；
- HTTP/file 地址、本机路径和敏感 query/播放 ID 不进入消息、safeDetails 或复制文本；
- 不展示原始 stack；
- 诊断只保留操作名等有限安全详情，最多 12 项并限制文本长度。

## 验证

```powershell
npx vitest run tests/diagnostics.test.ts tests/playback.test.ts tests/detachable-player.test.ts tests/vue-renderer.test.ts
npm run typecheck
npm test
npm run electron:package:win
npm run electron:e2e:package
```

专项结果：5 个文件/32 个测试通过；全量 21 个文件/126 个测试通过；Windows 打包通过；packaged E2E first/restarted 两轮通过，并确认错误卡、诊断展开/复制入口、HTMLVideoElement/HLS 错误码、播放器切换、Proxy 和资源清理。
