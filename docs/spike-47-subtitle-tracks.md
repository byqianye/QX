# G47 字幕轨道

## 状态

已完成。字幕轨道沿用现有 `playerContent → Desktop playback source → renderer` 链路；远程字幕在主进程通过独立 LocalProxy session 转换为本机受控 URL，renderer 不接触上游请求头。

## 合同

`src/subtitles.ts` 定义：

```text
SubtitleTrack {
  id
  label
  language
  format
  url?
  localPath?
  headers?
  default
  forced
}
```

来源可以标记为 Source、Jellyfin、本地文件、LocalProxy 或 fixture。来源返回的本机路径不会被接受；本地字幕只能由用户通过文件选择器提供。

## 格式与编码

- WebVTT 和 SRT 解析为统一 cue 时间轴；
- ASS/SSA 只转换基础 `Dialogue`，处理换行和基础文本，不执行 override tag、脚本或完整特效；
- 支持 UTF-8、UTF-8 BOM、UTF-16 LE/BE，以及有限的 GB18030、GBK、Big5 识别；
- 无法可靠判断时返回 `SUBTITLE_ENCODING_UNKNOWN`，界面允许用户选择编码后重试；
- 结束时间不晚于开始时间时返回 `SUBTITLE_TIMELINE_INVALID`。

所有 cue 文本在进入原生 `<track>` 前转义危险标签，不使用 `innerHTML`。SRT/ASS 先转换为安全的 UTF-8 WebVTT。

## UI 与清理

`SubtitleTrackPanel.vue` 提供字幕开关、轨道、编码、字号、位置、背景和 forced 提示，也提供本地文件选择。远程 URL 只接受 LocalProxy URL；本地生成的对象 URL 由 `SubtitleObjectUrlRegistry` 在切换、停止和卸载时及时 revoke。

## 验证命令

```powershell
npx vitest run tests/subtitles.test.ts tests/subtitle-ui.test.ts tests/electron-e2e.test.ts tests/desktop-ui.test.ts
npm run typecheck
npm test
npm run electron:build
npm run electron:e2e:package
```

packaged E2E 验证至少两条字幕轨道、每条轨道走 `__qx_playback`、renderer 不带 headers，以及编码和本地文件控件存在。

## 非目标

不宣称完整 ASS 特效兼容，不执行字幕脚本，不接受来源提供的任意本机文件路径，不接入未授权媒体源，也不把字幕代理扩展为开放代理。
