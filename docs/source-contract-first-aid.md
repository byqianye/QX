# `csp_FirstAid` 真实 HTTP 契约

状态：已接入后端，真实分类→详情→播放 canary 已通过（2026-08-15）。

## 能力边界

这是一个内置的 HTML HTTP 适配器，不执行 Android DEX/JAR、JavaScript 或 Python。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 首页 | 支持 | 请求 `GET https://m.youlai.cn/jijiu`，返回 8 个固定急救分类 |
| 分类 | 支持 | 同一页面按 `jijiu\|0` 到 `jijiu\|7` 选择 `div.jj-title-li` |
| 详情 | 支持 | 只接受 `https://m.youlai.cn/jijiu/...` 页面 |
| 播放 | 支持 | 读取详情页 `video#video` 的 MP4，允许 `m.youlai.cn` 或 `vod.youlai.cn` |
| 搜索 | 不支持 | 当前站点搜索页没有旧版视频结果；不会伪造搜索结果 |
| 分页/筛选 | 不支持 | 当前 `/jijiu` 是静态分类页面 |

## 当前页面选择器

- 分类图片：`img.block100`。
- 分类项目：`li.list-br3 a`。
- 项目名称：`div.line-clamp1`。
- 详情标题：`.video-title`（当前实际标签为 `h2`）。
- 详情封面：`.video-cover img`。
- 医生：`span.doc-name`。
- 简介：`.img-text-con`。
- 播放地址：`video#video[src]`，没有时回退到详情页内的 `source[src]`。

## 验证

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib first_aid -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib first_aid -- --ignored --nocapture
```

第二条命令是真实网络 canary，会依次验证分类、详情和播放器返回的 MP4 URL；网络或站点结构变化时应视为源失效，不应放宽 URL 白名单来“修复”。
