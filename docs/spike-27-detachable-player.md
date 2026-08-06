# Spike 27：独立播放窗口

## 状态

设计已确定，G28 已实现，待提交验收。

## 选择

采用 B：销毁旧播放器宿主，并在独立窗口恢复同一个逻辑 Playback Session。

原因：Electron 不能把一个 renderer 的 `<video>` DOM 节点直接迁移到另一个 `BrowserWindow`。把宿主迁移抽象成跨窗口 DOM 操作会扩大 Electron 生命周期边界；B 可以保留既有 Spider Session、媒体 source 和 LocalProxy Session，只重建一个受控 `<video>` 宿主。

## 单会话模型

`DesktopSpiderUiController` 持有唯一的 `playbackSession`：

- `id`：一次成功 `playerContent` 的稳定会话 ID；嵌入/独立切换不改变；
- 当前线路、当前集和安全媒体信息；
- `EmbeddedPlaybackController` 的播放时间、时长、音量、静音和暂停/播放状态；
- `host`：`embedded` 或 `detached`。

带请求头的媒体只在第一次成功解析时创建一个 `PlaybackProxySession`。切换宿主只复用现有的受控 Proxy URL，不再次调用 `playerContent`，也不创建第二个 token。

## 窗口与宿主生命周期

- 主窗口点击“独立窗口”后先进入 `detached` 状态，再创建一个 child `BrowserWindow`；主窗口卸载内嵌 `<video>`，避免后台声音。
- child 加载同一个本地 renderer 的 player-window 模式，通过 `/api/state` 取得当前安全播放状态。
- child 控制产生的时间、音量、静音和暂停状态通过 `/api/player/sync` 回写服务层；重建宿主时按该状态恢复，时间恢复误差目标不超过 2 秒。
- “返回主窗口”先切回 `embedded`，关闭 child，再由主窗口重新挂载 `<video>`。
- child 被用户直接关闭时，main 将状态恢复为 `embedded` 并通知主 renderer。
- 主窗口退出先关闭 child，再关闭 UI server、Spider Session、sidecar、Proxy 和媒体资源。

## 可验证 seams

1. `DesktopSpiderUiController`：detach/attach 保留 session ID、source、选集、Proxy URL 和同步后的 media state。
2. `DesktopSpiderUiServer`：detach、attach、sync、stop HTTP 合同及 callback 生命周期。
3. renderer `App` / `PlayerWindow`：detached 时主窗口不渲染 `<video>`，child 显示当前线路/剧集和控制面板。
4. packaged E2E：嵌入→独立→嵌入、单次 playerContent、单 Proxy URL、子窗口/主窗口清理。

## 明确不做

- 不做画中画、系统媒体控制或第二个播放器；
- 不重写 Spider、Session、LocalProxy 合同；
- 不把 token、完整 source URL 或播放状态写入 G27 持久化文件；
- 不把 fixture 描述为真实影视源。

## 验证命令

```powershell
npx vitest run tests/detachable-player.test.ts tests/desktop-ui.test.ts tests/vue-renderer.test.ts
npm run typecheck
npm test
npm run electron:e2e:package
```

## G28 实现补充

- 主窗口使用两阶段切换：先调用 `/api/player/detach`，服务端只把同一个 Playback Session 标记为 `detached`；renderer 在 `nextTick` 中卸载主窗口 `<video>` 后，才调用 `/api/player/open` 创建子窗口。
- 子窗口关闭或点击“返回主窗口”时，先关闭子窗口并等待 `closed` 事件，再把同一个 Session 切回 `embedded`，因此不会短暂保留两个有声宿主。
- 切换期间不重新调用 `playerContent`，不重建 Playback Proxy；子窗口通过 `/api/state` 和 `/api/player/sync` 复用媒体 URL、线路、选集、时间、音量、静音及暂停状态。
- 时间恢复以 2 秒为显式误差目标；播放器在加载元数据和时长变化时恢复服务端保存的时间。
