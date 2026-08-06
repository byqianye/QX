# Spike 22：VOD 详情、线路、选集到播放闭环

## 状态

G23 的受控点播闭环实现说明。范围覆盖 JVM-native fixture、CatVod 字段解析、Desktop UI 选择状态、`playerContent` 参数传递、G22 LocalProxy 和打包 E2E。

## 受控链路

```text
导入配置 → 信任确认 → 选择站点 → 首页/分类/搜索 → 详情
→ vod_play_from / vod_play_url → 线路 → 选集
→ 同一个 Spider Session 的 playerContent → LocalProxy → 内嵌播放器
```

`fixtures/jvm/PlayableJvmSpider.java` 是本地测试 Spider，不代表第三方影视源。它实现 `init`、`homeContent`、`categoryContent`、`searchContent`、`detailContent`、`playerContent` 和 `destroy`，播放请求只访问测试 HTTP fixture。

## CatVod 播放协议

- 线路由 `$$$` 分隔。
- 剧集由 `#` 分隔。
- 集名和播放 ID 由第一个未编码的 `$` 分隔。
- `PlaybackLine` 保存线路索引、线路标签和有序剧集。
- `PlaybackEpisode` 保存剧集索引、显示名和真实播放 ID。
- `PlaybackSelection` 只保存线路索引和剧集索引，UI 不把显示名当成播放 ID。

支持中文、空格、Unicode、查询参数、百分号编码保留字符、单/多线路、单/多集、空线路、空剧集、缺失集名（例如 `$url`）和重复集名。

未编码的 `$$$`、`#`、`$` 会造成字段边界歧义。解析器不会猜测：空 ID、ID 中再次出现 `$`、缺失 `$` 分隔符，以及由未编码 `#` 产生的裸片段均返回 `PLAYBACK_FORMAT_INVALID`。错误消息只保留线路位置，不输出原始 URL 或敏感参数。

## UI 和生命周期

- 详情页渲染线路标签、当前线路、剧集、当前集、正序/倒序和播放状态。
- 点击剧集向 `/api/player` 传递线路索引、剧集索引和 `vipFlags`；服务端再用解析后的线路名作为 `flag`、真实 ID 作为 `id`。
- 切集会先停止旧播放器，关闭旧 LocalProxy session，再用同一个 Spider Session 创建新的播放会话。
- 带请求头的结果继续由 G22 LocalProxy 接管；无请求头的结果保持直接交给内嵌播放器。
- 播放失败保留详情、线路和当前选集，显示错误并提供重试与切线路路径。
- UI server、Spider Session、sidecar、fixture server、LocalProxy token/端口和播放器资源在关闭时释放。

## 验证

```powershell
npm run typecheck
npm test
npm run electron:e2e:package
```

专项测试覆盖分隔协议、保留字符错误、JVM fixture 全链路、`playerContent` 参数、LocalProxy headers、切集、切线路、失败恢复和生命周期清理。打包验证覆盖导入、信任、选站、首页、详情、线路、选集、MP4/HLS/受保护 HLS 播放、切集、切线路、关闭以及 sidecar/PID/端口清理。

## 非目标

本 Spike 不接入未授权影视站、聚合搜索、自动线路故障转移、`parse=1`、mpv 或 Vue renderer，也不声称第三方影视源已完成。
