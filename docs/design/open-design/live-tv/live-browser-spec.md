# Live browser and playback spec

## G57 页面结构

直播源管理页在现有 Open Design 工作台中向下扩展为：

1. G56 导入/预览/确认表单和已保存来源卡片。
2. 频道目录：左侧分组按钮，右侧频道列表；列表只渲染当前分组的首批 40 项，
   滚动到底部再追加窗口。
3. 播放面板：当前频道、会话状态、复用的 EmbeddedPlayer、手动线路按钮和错误信息。
4. 最近频道：只显示频道/来源标识和时间，不显示播放地址或请求头。

## 交互状态

```text
catalog-empty → catalog-ready → selecting → loading → playing
                                      └────→ switching → loading
                                      └────→ error → retry/select-line
playing → buffering → playing
playing → stopped
```

- 点击频道使用默认线路；点击线路只切换当前频道的明确线路。
- 上下键移动焦点，回车播放；输入、选择框和文本框获得焦点时不拦截快捷键。
- 来源停用、移除或刷新后，会话停止且频道从启用目录消失。
- 播放错误同时显示稳定 code 和可执行动作；不使用颜色单独表达状态。

## 视觉与数据边界

- 继续使用 `design-system.md` 的 Neutral Modern token、panel、status chip、focus ring
  和 44px 最小命中区域；不新增配色体系、渐变或外部图片 CDN。
- 频道 logo 仅接受安全的 HTTP(S) 地址；没有 logo 时使用频道首字占位。
- 目录不接触 `LiveChannelStreamRecord.url`、headers、raw playlist 或 SQLite；播放
  会话由主进程产生受控播放器状态，播放器之外的频道卡片只拿到元数据。
- G57 不显示节目单时间轴或健康分数；两者保留明确的暂无/占位状态，分别由 G58/G59
  接入。
