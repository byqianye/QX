# G123 AppRJ 当前合同审计

审计时间：2026-08-24（Asia/Shanghai）。范围仅为肥猫配置中的 `csp_AppRJ`（站点 key“潮流”，当前 `ext=http://v.rbotv.cn/`）。结论基于当前仓库源码、脱敏实时请求和公开 Spider 二进制的静态反编译；没有执行下载的 JAR/DEX/远程脚本。

## 结论

`home/category/search/detail/player` 的生产端点、multipart 请求和签名合同仍有效。2026-08-24 实时请求均能返回 HTTP 200 JSON，但同一批探测也复现了远端主动断开连接；随后以相同合同重试即成功。因此先前 category transport failure 是当前上游波动证据，不是路径或签名已失效的证据。[肥猫配置站](http://xn--z7x900a.net/) 当前仍解出 39 个站点，其中“潮流”为字符串 ext `http://v.rbotv.cn`。

`nested.trim_start().starts_with("#EXTM3U")` 的失败是 canary 判断陈旧：本次 parser 线路返回的顶层资源已经是 media playlist（有 `#EXTINF`、无 `#EXT-X-STREAM-INF`），其第一个非注释 URI 是媒体段，不是嵌套清单。该资源返回 HTTP 200、`Content-Type: image/png`、818,809 字节；前 69 字节是完整 PNG，紧接着是 818,740 字节、4,355 个完整 188-byte MPEG-TS packet。默认 UA 与 parser 返回 UA 得到相同正文。生产 AppRJ 适配器只负责返回顶层播放 URL 与 UA，并没有执行 canary 的“首 URI 必为 nested manifest”断言；故这次失败本身不证明生产 URL 适配器过时。[当前 NBY parser 端点（查询值已省略）](https://api.nbyjson.top:7788/api/)

## 当前合同对照

| 能力 | 当前 Rust 实现 | 2026-08-24 实时结构 | 公开 Spider 静态实现 |
| --- | --- | --- | --- |
| 配置 | `configurable_base("http://v.rbotv.cn", ext)`，当前字符串 ext 可直接使用 | 肥猫配置仍给出 `csp_AppRJ` + 字符串 ext | 公共配置同样声明 `csp_AppRJ`，但示例 ext 为 `{ "url": ... }`。[固定提交配置](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/api.json#L11) |
| Home | POST `/v3/type/top_type`；映射 `data.list` 为 `class` | HTTP 200 JSON；`data.list` 10 项，分类项含 `type_id/type_name/extend/area/lang/year`。[端点](http://v.rbotv.cn/v3/type/top_type) | 同端点；还把 `extend/area/lang/year` 组装为 filters。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar) |
| Category | POST `/v3/home/type_search`；`type_id,limit=12,page`，可附 `area/class/lang/year` | HTTP 200 JSON；本次 12 项，条目含 `vod_id/vod_pic/vod_pic_thumb/vod_name/vod_remarks/type_id/tag`。[端点](http://v.rbotv.cn/v3/home/type_search) | 相同字段和过滤参数。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar) |
| Search | POST `/v3/home/search`；`keyword,limit=12,page` | HTTP 200 JSON；本次脱敏关键词返回 1 项。[端点](http://v.rbotv.cn/v3/home/search) | 相同路径，公开实现固定 `page=1`。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar) |
| Detail | POST `/v3/home/vod_details`；读取 `data.vod_play_list` | HTTP 200 JSON；样本有 3 条线路：1 条带 UA、1 个 `parse_urls`、opaque episode；2 条无 UA/Referer、无 parser、episode 为直接 `.m3u8`。[端点](http://v.rbotv.cn/v3/home/vod_details) | 把 episode 编码为 `name$parseChain|url|ua|vodName|nid`，与 Rust 格式一致。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar) |
| API 签名 | multipart/form-data；固定 API UA；每次请求附秒级 `timestamp` 和 `MD5(<redacted-static-secret> + timestamp)`；禁重定向 | 四个端点在正确签名下返回 `{msg,code,data}`；未观察到响应 MAC/签名字段 | 同一公式、multipart 和 API UA。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar) |
| Player | 无第一方 player POST；直接媒体返回 `parse=0`。parse chain 只允许精确 NBY HTTPS host/port/path，并校验 parser JSON 后返回 `parse=0` + `User-Agent` | NBY parser 的带签名和不带签名请求本次都返回 HTTP 200 JSON、`code=200`、URL 和 UA；URL 路径为 `/nby/m3u8/getM3u8`（查询字段和值均已删除）。[parser 端点](https://api.nbyjson.top:7788/api/) | 逐个调用 `parse_urls`，附 timestamp/sign 和空 Referer，读取 `url/UA`；最终 Result 标记 `parse=1` 并交给 TVBox player。AppRJ/Proxy 类内未发现 PNG→TS 解包。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar) |

本地对应实现见 [`legacy_http.rs`](../../../src-tauri/src/legacy_http.rs)：端点分派约在 L777，签名与 multipart 约在 L907/L926，详情线路约在 L1014/L1042，媒体与 NBY parser 白名单约在 L1139-L1288，实网 canary 约在 L6155。

## HLS 当前行为

1. Parser 线路：NBY parser 给出顶层 `/nby/m3u8/getM3u8`（查询字段和值已删除）；直连探测为 HTTP 200、`application/octet-stream`、44,290 字节，内容是 media playlist。第一个 URI 为 `/nby/m3u8/play/ts/<opaque>`，无扩展名。该 URI 返回 HTTP 200、`image/png`；PNG 的 `IEND` 结束位置与 MPEG-TS 同步起点同为 byte 69，余下长度严格为 `188 × 4,355`。[parser 端点](https://api.nbyjson.top:7788/api/)
2. 直接线路：一个当前直接 `.m3u8` 返回 HTTP 200、`application/vnd.apple.mpegurl`、96 字节 master playlist；其首个 `.m3u8` 子资源返回 HTTP 200、同 MIME、27,622 字节有效 HLS media playlist。另一直接线路在 10 秒直连界限内超时，未据此扩展结论。[详情端点](http://v.rbotv.cn/v3/home/vod_details)
3. 公开 Spider 只解析 API/parser 并把最终 URL 交给播放器，没有把首个媒体 URI 再次当作 manifest，也没有静态 PNG/TS 转换路径。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar)

因此“direct/nested”必须由 HLS 标签决定，而不能由“它是首个 URI”决定：有 `#EXT-X-STREAM-INF` 才进入子清单；已有 `#EXTINF` 时首 URI 是媒体段，即使路径无 `.ts` 且 MIME/前缀伪装成 PNG。

## 差异与边界

- Rust `apprj_home` 当前丢弃了 live/public Spider 已提供的 filter metadata，尽管 category 接收过滤参数且 capability 声明 `filters=true`。这是真实映射差异，但与本次播放失败无因果关系。[Home 端点](http://v.rbotv.cn/v3/type/top_type) [公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar)
- 公开 Spider 在 parser 后返回 `parse=1`；Rust 对经过白名单和响应校验的 URL 返回 `parse=0`。实时 parser 和直接 HLS 都支持当前 Rust handoff，因此尚无证据仅为对齐标志而改回 `parse=1`。[公开 JAR](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar)
- Rust 的 NBY 请求未追加公开 Spider 使用的 timestamp/sign；本次同一 token 的 unsigned/signed 两种请求都成功。不要把当前“签名可省”扩大为长期服务器保证，也不要记录 parser key、episode token 或完整 URL。[parser 端点](https://api.nbyjson.top:7788/api/)
- 当前三条样本线路的 `referer` 都为空；只有 parser 线路有 UA。Rust 已保留 UA，未添加凭据、Cookie 或猜测性 Referer。[详情端点](http://v.rbotv.cn/v3/home/vod_details)

## 脱敏命令与证据

```text
# 本地实现/测试
rg -n "AppRJ|apprj_|nested|EXTM3U" src-tauri/src/legacy_http.rs
cargo test --manifest-path src-tauri/Cargo.toml \
  legacy_http::tests::real_apprj_read_detail_player_transport_chain \
  -- --ignored --exact --nocapture

# 实时 API（实际 timestamp/sign、type_id、keyword、vod_id 均未保存）
POST http://v.rbotv.cn/v3/type/top_type    multipart: timestamp=<redacted>, sign=<redacted>
POST http://v.rbotv.cn/v3/home/type_search multipart: type_id=<redacted>, limit=12, page=1, ...
POST http://v.rbotv.cn/v3/home/search       multipart: keyword=<redacted>, limit=12, page=1, ...
POST http://v.rbotv.cn/v3/home/vod_details  multipart: vod_id=<redacted>, ...

# HLS（curl 直连；完整 parser/media URL 与所有查询值均未输出）
curl --noproxy '*' --location --user-agent '<redacted-UA>' '<url>?<redacted>'
# 记录：HTTP status、Content-Type、长度、HLS tags、PNG chunk end、188-byte TS sync/alignment、SHA-256 前缀

# 公开 Spider：只下载、哈希和反编译，不运行
Get-FileHash spider.jar -Algorithm MD5/SHA256
decompile.ps1 -InputFile spider.jar -NoRes -Engine jadx
rg -n "class AppRJ|type_search|vod_details|parse_urls|playerContent" <decompiled-sources>
```

公开 JAR 来自固定提交，1,876,244 字节；MD5 `e9d5d420f8e86d6f1f6d4eec810f6153` 与其 [公共配置声明](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/api.json#L2)一致，SHA-256 为 `f811304d32c7fb5ef81142371d6194258c4707534eebea30a0492298c45e9e68`。Jadx 报告 20 个全包反编译错误，但目标 `AppRJ.java` 完整生成；以上结论只使用目标类和其 Result 模型的可读静态代码。[JAR 原件](https://github.com/qist/tvbox/blob/0ec63afd14dd4d7f66d291f3231b5e03c2ef583f/xiaosa/spider.jar)

## 建议的有界改动

本次 HLS 失败不支持修改生产 AppRJ URL/parser 逻辑；应先修 canary：仅在顶层含 `#EXT-X-STREAM-INF` 时读取 nested manifest，含 `#EXTINF` 时把首 URI 当作 segment；segment 验收允许原生 TS，或“可完整解析、前缀不超过 4 KiB、`IEND` 后立即出现至少 4 个连续 188-byte TS packet 且剩余长度整除 188”的 PNG+TS 包装。请求应复用 player 返回的 UA。增加三个稳定 loopback 测试：master→media、media→raw TS、media→69-byte PNG+packet-aligned TS；畸形 PNG/错位 TS 必须失败。

另一个独立且有实时证据支持的最小生产改动，是 AppRJ 四个只读 POST 在连接重置/连接超时后至多重试一次，并重新生成 timestamp/sign；不得重试 HTTP 4xx、JSON/业务错误或 parser 失败。用 loopback 锁定“首连接关闭→第二次 200”和“404 只请求一次”。除这项传输韧性外，在桌面 E2E 证明 PNG+TS 无法播放之前，不应在生产适配器或播放代理中增加解包逻辑。

## 后续桌面验证与实施结论

同日后续桌面跟踪证明，生产链路另有三个独立集成缺口：前端曾在第一个 `|` 截断 AppRJ episode handoff，Rust player 只接受带 `$` 的详情全集条目，播放代理又把无 `.m3u8` 后缀的 `/nby/m3u8/getM3u8` 误判为 progressive。修复后，NBY 首个分片还会进行一次跨源 302 到公开 `.png` 对象；实现只对白名单 `/nby/m3u8/play/ts/` 开放这一跳，并重新校验公开目标、禁止凭据、限制 `.png` 路径，跨源只保留 `User-Agent`。其他重定向仍 fail closed。

Tauri WebView 已直接解码上述 69-byte PNG + TS 包装段，观测到 `1920×818`、约 `5.96s` 的真实播放，因此没有增加 PNG 剥离。样本第二分片随后返回 404，其他两条直连线路分别启动超时或目标不可达，所以本次没有 20 秒通过 artifact；该结果证明本地 handoff、代理和解码边界已越过，但不证明当前 AppRJ 内容或全部线路稳定可用。实网 canary 最多继续检查 8 条已解析媒体候选，单条失败不会提前终止，全部失败仍硬失败；它禁用自动重定向并复用生产的一跳 NBY PNG 边界，日志只保留脱敏媒体路径、字节数和包装偏移。稳定 loopback 已覆盖 master→media→raw TS、media→单跳 PNG+TS、二次跳转拒绝和错位 TS 拒绝；episode 尾部元数据也对 `%`/`|` 做可逆转义。四个只读 POST 的一次性瞬态重试建议本轮未实施，继续作为独立韧性增量，不与播放修复混合。
