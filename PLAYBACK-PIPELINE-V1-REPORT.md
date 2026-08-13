# G98 Parse / Media / Player 完整播放闭环验收

## 最终状态

```text
PLAYBACK_PIPELINE_V1=PASS
```

验收日期：2026-08-09

## 真实 Android DEX 来源

来源：`csp_Jianpian`（荐片）

```text
searchContent       PASS，resultCount=20
detailContent       PASS，vod_id=54437
play lines          29
episodes            1187
playerContent       PASS
parse               0
jx                  0
header              present
```

## 真实浏览器播放证据

通过本地 Playback Proxy 加载真实 HLS，未将上游播放地址或认证信息写入报告。

```text
readyState          4
duration            2690s
video dimensions    1920x1080
currentTime delta   21.942s during a 22s browser run
fatalError          null
manifest            local proxy HTTP 200
segments            local proxy HTTP 200/206
audio decoded       359265 bytes at the end of the playback window
```

服务端 trace 已覆盖：

```text
SOURCE DETAIL EPISODE PLAYER_CONTENT MEDIA_RESOLVE PROXY_START
MANIFEST VARIANT SEGMENT DECODER PLAYING
```

播放健康状态：`resolveSuccess=true`、`fatalError=null`、`segmentFailure=null`。

浏览器截图确认播放器实际显示视频画面；播放器未静音，且 Chromium 的音频解码计数持续增长。

## 自动化验证

```text
npm run typecheck    PASS
npm test             PASS（93 files / 497 tests）
git diff --check     PASS（仅有 Git 的 LF/CRLF 提示）
```

## 本 Goal 范围内的实现

- 统一 `QxPlayerResult`，保留 `url/parse/jx/playUrl/header/format/flag` 和来源上下文。
- 新增 `MediaResolver`，区分 HLS、DASH、MP4、FLV、网页和未知类型，并统一进入本地代理。
- 播放代理支持重定向、跨 CDN HLS 资源、分片、密钥、MAP 和 Range 请求，同时清理跨域转发的敏感请求头。
- 嵌入式播放器同步生命周期和播放诊断 trace。
- 让真实 Android DEX `csp_Jianpian` 通过 RuntimeManager 进入桌面播放链路。

## 未完成事项与风险

- 本次验收覆盖真实画面、音频解码字节、连续播放和代理网络请求；没有额外覆盖所有 Android DEX 来源。
- 上游源的可用性、线路数量和认证状态仍属于第三方运行时变量。
- 未执行打包发布；这符合 G98 明确的范围限制。
