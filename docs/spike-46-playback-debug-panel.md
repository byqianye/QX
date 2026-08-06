# G46 播放调试面板

## 状态

已完成。G46 在 renderer 提供本地播放调试面板、有限长度时间线和脱敏复制/导出；数据不上传服务器，也不读取日志文件或凭据。

## 入口与面板

面板支持三种入口：

- 全局普通键盘 `D` 开关；`Ctrl/Alt/Meta+D` 不触发。
- 设置 → 诊断与日志 → 播放调试。
- 播放错误详情或播放诊断 → 播放调试。

输入框、textarea、select 和 contenteditable 聚焦时普通 `D` 不触发。面板显示 Source、Engine、Site、Playback Session、线路、剧集、playerContent、parse、Rules、sniff、LocalProxy、后端、起播时间、缓冲、错误、回退和 capability。

## PlaybackEvent 合同

`renderer/src/playback-debug.ts` 定义：

```ts
PlaybackEvent {
  timestamp
  sessionId
  phase
  type
  source
  durationMs?
  safeDetails
}
```

`PlaybackDebugTimeline` 保留最近 200 个事件，按记录顺序输出，并从 pending、playerContent、parse、Rules、sniff、LocalProxy、后端、buffer、error 和 fallback 状态变化推导事件。Session ID 使用稳定 hash 显示；地址、Cookie、Authorization、token、私有服务器、用户目录、播放 ID 和 raw stack 不进入事件或快照。

面板只消费 `PlaybackDebugSnapshot`。复制使用系统剪贴板或 textarea fallback；JSON/文本导出通过本地 Blob 下载，不发起网络请求。导出内容继续经过同一套脱敏规则。

## 验证

- `tests/playback-debug.test.ts`：顺序、上限、全阶段、起播/缓冲汇总、脱敏和 JSON/文本导出。
- `tests/playback-debug-ui.test.ts`：D、输入框焦点、设置入口、错误入口、面板字段、复制和导出。
- packaged E2E first/restarted 两轮检查 `playbackDebug=true`，并确认 17 个字段、时间线存在、输入框不会被 D 打开且面板文本无敏感地址。

G46 不引入远程日志服务，不展示真实 Proxy URL 或源站地址；后续 G48 可在本合同上补充流健康指标和回退原因。
