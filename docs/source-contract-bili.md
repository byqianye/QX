# `csp_Bili` 真实 HTTP 契约

状态：已接入后端，真实搜索→详情→MP4 播放 canary 已通过（2026-08-15）。

## 能力边界

这是 Rust 内置的公开 JSON 适配器，不加载原 Android DEX/JAR，也不执行源代码。

| 能力 | 接口 | 说明 |
| --- | --- | --- |
| 首页 | `GET https://api.bilibili.com/x/web-interface/popular?ps=20` | 映射 `data.list` |
| 分类 | 同上，增加 `pn` | 当前按热门分页，不伪造 B 站分类树 |
| 搜索 | `GET /x/web-interface/search/type?search_type=video&keyword=...&page=...` | 映射 `data.result` |
| 详情 | `GET /x/web-interface/view?bvid=...` | 读取 `pages[].cid` |
| 播放 | `GET /x/player/playurl?avid=...&cid=...&fnval=0&fourk=1` | 只使用 `data.durl[].url` 直链 MP4 |

搜索结果 ID 为 `bvid@aid`；详情播放项 ID 为 `aid+cid`。

## 明确未承诺

- 不实现 WBI 签名、登录态、会员清晰度策略。
- 不实现 DASH 音视频合并、弹幕和原 Android 源的代理 MPD。
- 如果接口只返回 `dash` 而没有 `durl`，播放器会明确报 `BILI_PLAYER_DURL_MISSING`，不会把不完整的 DASH 数据伪装成 MP4。

## 验证

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib bili -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib bili::tests::real_endpoint_completes_search_detail_and_mp4_player_chain -- --ignored --nocapture
```
