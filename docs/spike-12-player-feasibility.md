# Spike 12：`playerContent` 可行性验证

## 目标

确认 `csp_Douban` 是否能为桌面端提供可移植的 `playerContent`：

1. DEX 是否覆写 `playerContent`；
2. Frodo 电影/TV 详情是否包含桌面可解析的完整播放地址；
3. 是否值得新增 JVM-native `player` RPC。

## 验证命令

```text
npm run spike:douban-player
```

默认验证电影 `36246195` 和 TV `36721173`，可用
`QX_DOUBAN_MOVIE_ID`、`QX_DOUBAN_TV_ID` 替换。

## 结果

- Spike 7 的 JADX 方法检查确认 DEX 没有覆写 `playerContent`，因此不存在需要忠实重编译的原始播放逻辑；
- 两个 Frodo 详情都返回 `video: null`；
- 电影和 TV 都有 `trailers[].video_url`，是独立的 HTTP MP4 预告片地址，不是正片播放源；
- TV 的 `vendors`/`linewatches` 只有腾讯等应用深链（如 `txvideo:`），不是桌面端可直接消费的 HTTP 流地址；
- 当前 DEX 和这两个测试条目没有可确认的完整内容播放 URL；探针会扫描详情 JSON 中的播放候选字段，不把预告片地址计入正片地址。

## 决策

基于当前 DEX 和两个测试条目，暂不新增通用 JVM `playerContent`/`player` RPC，也不启动 Android Emulator/DEX。当前证据只能说明这组 Douban 元数据没有桌面可解析的正片地址，不能外推所有条目。

若产品明确需要预告片播放，可另定义“预告片条目”的 ID 合同；若需要正片播放，则应单独接入腾讯等来源的解析器或播放协议，不能把 Douban 详情字段直接当成通用播放地址。
