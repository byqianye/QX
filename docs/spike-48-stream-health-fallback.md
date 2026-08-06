# G48 流健康和自动线路回退

## 状态

已完成。G48 在现有播放 Session、LocalProxy、解析链、播放器同步和 G46 调试时间线之上，增加了内存健康指标、可解释评分、有界回退协调器和 renderer 操作面板。

## 健康合同

`src/health/playback-health.ts` 的 `PlaybackHealthTracker` 记录：

- `resolveSuccess`、`firstFrameMs`、`startupFailure`；
- `bufferingCount`、`bufferingDuration`、`fatalError`；
- `httpStatus`、`segmentFailure`；
- `playbackDuration`、`completion`、`lastSuccess`、`consecutiveFailures`。

每个指标都带 `samples`。没有样本时值显示为 `unknown`，不把缺失数据当成成功或失败。健康评分固定为 0–100，并按解析失败、首帧耗时、缓冲、分片失败、致命错误、HTTP 失败和连续失败扣分；评分同时返回扣分原因，便于测试和 UI 解释。

健康事件只保留有限长度的安全详情，并进入既有 G46 `PlaybackDebugTimeline`，事件类型包括起播、首帧、缓冲、HTTP、分片、致命错误、完成、暂停和 seek。不会把源地址、Cookie、Authorization、token 或本机路径写入快照。

## 回退合同

`PlaybackFallbackCoordinator` 支持：

- 关闭 `off`：只记录指标，不切线路；
- 仅提示 `prompt`：显示当前失败、原因和下一条候选，由用户批准；
- 自动 `auto`：自动执行候选并在成功后标记恢复。

候选顺序固定为：当前线路重试、当前线路重新解析、同内容其他线路、更健康候选。候选集合去重，尝试记录用于防循环；同时限制最大尝试次数、总超时和用户取消。单次短缓冲、用户暂停、seek 和短暂波动不会触发回退；连续两次分片失败才进入分片回退。

桌面控制器接入 `playerContent` 失败、parse 失败、Proxy/播放器致命错误、起播超时和连续分片错误。自动回退通过当前受控播放 Session 重新走 `playerContent → parse/Proxy → player`，不创建开放代理，也不切换到未经验证的地址。

## UI 与存储

`PlaybackHealthPanel.vue` 显示指标、评分、当前失败、原因、即将尝试线路、取消、返回、查看调试和回退模式选择。`/api/player/sync` 会等待自动回退任务完成后返回状态，避免 renderer 看到过期线路。

G50 前不引入正式 SQLite。当前使用进程内 `PlaybackHealthRegistry`，只服务当前桌面会话；未来若需要跨会话统计，应迁移 source/line 标识、样本窗口、时间戳、评分版本和隐私清理策略。

## 验证

```powershell
npm test
npm run typecheck
npm run renderer:build
npm run electron:build
npm run electron:e2e:package
```

结果：42 个测试文件、233 个测试通过；类型检查、renderer/Electron 构建通过；打包 E2E 首次和重启轮次均通过，`playbackHealth=true`；E2E 后没有残留项目进程。

## 非目标

不引入 SQLite，不做跨设备或跨会话健康云同步，不声明第三方线路可用性，不因短暂缓冲或用户主动操作自动切换，不实现服务端转码或开放代理。
