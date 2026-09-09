# G123 兔小贝当前合同与收口审计

审计日期：2026-08-24（Asia/Shanghai）

范围：`http://xn--z7x900a.net/` 当前 39 个 `sites`；配置只作为数据解码和字段统计，未加载或执行其中任何 JavaScript、JAR、DEX 或 Python。

本轮选定项：`儿童`（兔小贝）的固定公开搜索路径迁移；协议、运行时路由和桌面播放已按下述边界收口。

## 结论

当前目录仍为 39 站点。以下保留审计时按“当前可访问、固定无凭据 HTTP 合同、能形成真实读取/详情/player 链路、尚未完整收口”的排序；前四项均已按当前真实边界完成复测。剩余未完成项当前分别受默认 AppGet/AppQi 上游、凭据、登录、站点不可达或远程运行时边界阻断，没有可诚实顺延的第五个固定 HTTP 候选：

1. **儿童（兔小贝）**：本轮已收口。旧公开实现仍声明 `/search/index?key=**`，当前站点把该路径 302 到 `/search/{关键词}`；重定向头含原始非 ASCII 路径，Rust `reqwest` 在自动重定向发送阶段失败。适配器现在直接构造 percent-encoded 规范路径；真实搜索只用命中的 `/play/940` 完成详情、`parse=0` 与 CDN MP4 Range，桌面同一详情播放到 `20.466401s`。精确 `drpy2 + 兔小贝 ext` 由 renderer 交给 Rust SourceSession，未执行远程脚本。
2. **豆瓣预告（YGP）**：本轮已收口。严格 Rust canary 要求首页、分类、搜索分别非空，只从搜索结果继续详情、show、`parse=0` 与无 Referer MP4 Range；当前 `/movie/83408` 返回 32 bytes/`ftyp`，同一结果在 Tauri WebView 播放到 `20.464456s`、`1920×1080`、`readyState=4`。配置 `searchable=0`，所以不声明 UI 原生搜索。
3. **360 官源（SP360）**：本轮已按现有安全边界收口。严格 Rust canary 只从“流浪地球”搜索结果继续详情，完成 `parse=1` 和真实 provider 页面读取；Tauri 桌面也完成原生搜索、详情与六线路交接。默认 Bilibili 页面是无媒体标记的错误壳，Bilibili/芒果/优酷/腾讯四个受控 WebView 样本均 idle timeout，因此不声明首帧或可播放，也不扩大跨域访问、猜测媒体 URL 或执行 Android Spider。
4. **瓜子体育（GuaziTY）**：本轮已收口。当前配置关闭搜索；严格 canary 只在四个固定分类中读取当前赛事、详情、明确 `live_line` HLS 和首媒体分片。篮球赛事 `8466314` 的分片取数与同一详情桌面 20 秒播放通过；直播地址随后在分钟级失效，当前结论只覆盖验收时刻，不扩大为稳定点播能力。

AppRJ、番薯、荐片、厂长等已完成协议实现或已有明确桌面证据；默认肥猫/AppQi、Dm84、Wwys、SaoHuo、Kanqiu 等当前受上游不可达阻断；Duopan/Netfixtv、MiSou 需要 provider 凭据；这些都不应被伪装成新的无凭据固定 HTTP 候选。

## 审计口径与脱敏规则

- `[C]` 是当前肥猫配置本身，负责证明站点数、顺序、`api` 和 `ext` 形状；FongMi envelope 只在内存中解码，未保存原文。
- `[R]`、`[A]`、`[N]` 是当前 Rust 实现，负责证明运行时覆盖；`[S]`、`[G]` 是项目累计的真实 canary/E2E 状态。
- URL 只保留 scheme、host 和非敏感固定 path；查询串、媒体临时参数和长 opaque 路径不记录。
- AES/key/IV、`url_key`、Cookie、token、签名和其他身份字段只标为“值省略”，不记录原值。
- `type=3 + csp_*` 只说明原 TVBox 入口语义；本审计只承认仓库中已有独立固定 HTTP 合同的 Rust 子集，不把 JVM-native、Android DEX、QuickJS 混为一类。

## 当前 39 站点：脱敏 API/ext 形状与覆盖状态

| # | key / 名称 | API | ext 脱敏形状 | 当前覆盖与候选判定 | 主来源 |
| ---: | --- | --- | --- | --- | --- |
| 1 | 豆瓣 / 公众号占位 | `csp_Douban` | 无 | native 浏览已覆盖；播放按设计关闭，不是下一候选 | [C][S][N] |
| 2 | 豆瓣预告 | `csp_YGP` | 无 | 固定 6huo HTML 严格搜索结果链路、MP4 Range 和同一结果桌面 20 秒已通过；已收口 | [C][S][R][Y] |
| 3 | config / 配置中心 | `csp_Config` | 无 | 仅本地配置语义，无固定远端内容合同；排除 | [C][S][N] |
| 4 | csp_FeiMaoUC / 闪电优汐 | `csp_Duopan` | JSON：`site_urls[2]`、线程参数、凭据样字段（值省略） | MacCMS 页面子集可读；当前镜像 522，云盘播放需 UC 凭据；排除 | [C][S][R] |
| 5 | csp_Duopan / 蜡笔影视 | `csp_Duopan` | JSON：`site_urls[5]`、线程参数、凭据样字段（值省略） | 首页/分类/搜索/详情可读到分享 URL；播放明确 `AUTH_REQUIRED`；排除 | [C][S][R] |
| 6 | csp_Netfixtv / 至臻影视 | 配置实际为 `csp_Duopan` | JSON：`site_urls[5]`、线程参数、凭据样字段（值省略） | 与 Duopan 共用固定 MacCMS 子集；第五镜像可读但云盘播放需凭据；排除 | [C][S][R] |
| 7 | 潮流 | `csp_AppRJ` | base URL：`http://v.rbotv.cn/` | multipart + MD5 全链路已实现；桌面已解码约 5.96 秒，第二分片上游 404；无新的固定适配缺口 | [C][S][G][R] |
| 8 | 肥猫 | `csp_AppGet` | pipe：base `cms140.yhg.one` + 16-byte opaque 字段（值省略） | AppGet 合同已覆盖；当前 host 连接超时，停在 home；外部阻断 | [C][S][G][A] |
| 9 | 干饭 | `csp_AppGet` | pipe：discovery TXT URL + 16-byte opaque 字段（值省略） | 固定合同可解析；当前返回认证阻断；排除 | [C][S][G][A] |
| 10 | 光盘 | `csp_AppQi` | pipe：COS discovery TXT + 16-byte opaque 字段（值省略） | AppQi 合同已覆盖；discovery 后上游 502/连接失败；外部阻断 | [C][S][G][A] |
| 11 | 行动 | `csp_AppQi` | pipe：base URL + 16-byte opaque 字段（值省略） | 固定端点建连失败；外部阻断 | [C][S][G][A] |
| 12 | 再来 | `csp_AppGet` | pipe：base URL + 16-byte opaque 字段（值省略） | 当前建连失败；共享 AppGet 合同无需另写适配器 | [C][S][G][A] |
| 13 | 一碗 | `csp_AppGet` | pipe：base URL + 16-byte opaque 字段（值省略） | 真实读取/详情曾通过，player 是动态解析页并安全停止；排除动态解析扩张 | [C][S][G][A] |
| 14 | 蔬菜 | `csp_AppGet` | pipe：OSS discovery TXT + 16-byte opaque 字段（值省略） | 当前真实 `home/search/detail/player(parse=0)` 已通；共享合同已收口，不新建源适配 | [C][S][G][A] |
| 15 | 永永 | `csp_AppGet` | pipe[3]：base URL + 16-byte opaque 字段 + 短控制字段（值省略） | 当前上游 HTTP 500；外部阻断 | [C][S][G][A] |
| 16 | csp_Jpys / 金牌影视 | `csp_Jpys` | 无 | 固定签名 JSON 的搜索、详情、episode URL 已实网通过；协议实现已收口 | [C][S][R] |
| 17 | csp_Wwys / 农民影视 | `csp_Wwys` | base URL：`vip.wwgz.cn:5200` | 当前首页 404/模板缺失；仅明确媒体才允许播放；外部阻断 | [C][S][R] |
| 18 | 荐片 | `csp_Jianpian` | base URL：`api.ztcgi.com` | native 首页/海报/搜索/详情/HLS 和桌面 20 秒均已有证据；已收口 | [C][S][G][N] |
| 19 | csp_SaoHuo / 火火影视 | `csp_SaoHuo` | base URL：`shdy5.us` | 发布页发现已固定化；内容候选当前 522；外部阻断 | [C][S][R] |
| 20 | csp_Gz360 / 瓜子影视 | `csp_Gz360` | 无 | 固定 `/Pc` AES JSON 已实现；当前 API 返回系统错误/登录边界；排除凭据绕过 | [C][S][R] |
| 21 | 厂长 | `csp_Czsapp` | base URL：`czzy89.com` | 固定 HTML/iframe HLS、首分片和桌面 20 秒均通过；已收口 | [C][S][G][R] |
| 22 | csp_SP360 / 360 官源 | `csp_SP360` | 无 | 严格一方 JSON/JSONP 搜索链路与 provider 页面读取通过；桌面六线路交接通过、四个受控嗅探样本 idle timeout，当前不计首帧/可播放 | [C][S][R][P] |
| 23 | csp_Bili / 哔哩合集 | `csp_Bili` | JSON：公开列表 URL + 空 Cookie | Rust JSON/MP4 合同历史可用；当前搜索 412，不能增加猜测性反爬头 | [C][S][N] |
| 24 | csp_Dm84 / 动漫巴士 | `csp_Dm84` | base URL：`dm84.net` | 发布页与离线 HTML/iframe 合同已覆盖；内容候选 522；外部阻断 | [C][S][R] |
| 25 | 方舟 | `csp_AppGet` | pipe：base URL + 16-byte opaque 字段（值省略） | 当前真实 `home/search/detail/player(parse=0)` 已通；共享 AppGet 合同已覆盖 | [C][S][G][A] |
| 26 | 番薯 | `csp_AppGet` | pipe：base URL + 16-byte opaque 字段（值省略） | 指定 HLS 线路/第 6 集已完成两次桌面 20 秒；已收口 | [C][S][G][A] |
| 27 | csp_FirstAid / 急救教学 | `csp_FirstAid` | 无 | 固定分类→详情→MP4 已覆盖；源本身无搜索/分页，按有限能力收口 | [C][S][N] |
| 28 | 酷狗 | `csp_Kugou` | JSON：单一固定 class | 榜单/详情可读；播放依赖设备签名和反刷回调，无稳定固定合同；排除 | [C][S][R] |
| 29 | MTV / 明星 MV | `csp_Bili` | JSON：公开列表 URL（opaque path）+ 空 Cookie | Bili 别名；当前 412，与 #23 同一阻断，不做独立适配 | [C][S][N] |
| 30 | 看球 | `csp_Kanqiu` | 无 | 离线分类/详情/直链合同已覆盖；当前 HTTP→HTTPS 后 TLS 失败；外部阻断 | [C][S][R] |
| 31 | 瓜子 / 体育 | `csp_GuaziTY` | 无 | 固定 AES JSON、详情/HLS/首分片和桌面 20 秒通过；无 search，直播地址分钟级波动 | [C][S][R] |
| 32 | 米搜 | `csp_MiSou` | loopback provider 配置路径（内容未读） | 固定 `/api/disks` home/category/search 已覆盖；详情/播放依赖 WangPan 凭据和本地代理；排除 | [C][S][N] |
| 33 | csp_PanSearch / 盘搜 | `csp_PanSearch` | loopback credential 文件路径（内容未读） | 首页/双搜索合同已覆盖；源无详情/媒体端点，按有限能力收口 | [C][S][R] |
| 34 | 儿童 / 兔小贝 | 远程 `drpy2.min.js` URL | 远程 `兔小贝.js` URL | 精确 API/ext 组合由 renderer 交给 Rust 固定 JSONP/HTML 子集；规范搜索、严格实网 canary 与同一结果的桌面 20 秒播放已通过；不执行 JS | [C][S][R][T] |
| 35 | csp_少儿 / 教育 | `csp_Bili` | JSON：公开列表 URL（opaque path）+ 空 Cookie | Bili 别名；当前 412，且未恢复原教育筛选语义；不独立扩张 | [C][S][N] |
| 36 | csp_小学 / 课堂 | `csp_Bili` | JSON：公开列表 URL（opaque path）+ 空 Cookie | 同 #35 | [C][S][N] |
| 37 | csp_初中 / 课堂 | `csp_Bili` | JSON：公开列表 URL（opaque path）+ 空 Cookie | 同 #35 | [C][S][N] |
| 38 | csp_高中 / 课堂 | `csp_Bili` | JSON：公开列表 URL（opaque path）+ 空 Cookie | 同 #35 | [C][S][N] |
| 39 | push_agent | `csp_Push` | 相对配置 path | 受限 HTTP(S) URL hand-off 已覆盖；不是内容源，动态嗅探/非 HTTP 分支关闭 | [C][S][N] |

## 第一候选：兔小贝当前合同与真实失败点

### 主来源交叉核对

1. 当前配置的 `儿童` 项仍是远程 `drpy2.min.js` + `兔小贝.js` 的精确组合，但 Rust `kind_for` 只用 URL 形状识别它，随后走本地 `TuXiaoBei` 固定合同；远程脚本不被加载或执行。[C][R]
2. [公开原实现 `兔小贝.js`](https://github.com/fantaiying7/EXT/blob/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js) 当前仍声明：固定 host `www.tuxiaobei.com`、分类 `/list/mip-data`、详情 `/play/{id}`，以及旧搜索 `/search/index?key=**`。这份源文件只按文本读取。[T]
3. 第一方旧搜索 [ `/search/index?key=江南style` ](https://www.tuxiaobei.com/search/index?key=%E6%B1%9F%E5%8D%97style) 当前返回 302，`Location` 语义为 `/search/江南style`；原始非 ASCII header 在客户端侧出现乱码，Rust `reqwest` 自动跟随时在发送重定向请求前失败。
4. 第一方规范搜索 [ `/search/江南style` ](https://www.tuxiaobei.com/search/%E6%B1%9F%E5%8D%97style) 直接返回 HTTP 200、7,546 bytes，并含 2 个 `/play/{数字}` 条目。没有 Cookie、token 或动态脚本执行。
5. 第一方分类 [`/list/mip-data?typeId=2&page=1&callback=`](https://www.tuxiaobei.com/list/mip-data?typeId=2&page=1&callback=) 返回 HTTP 200 JSONP，本次有 30 项；搜索命中的 [`/play/940`](https://www.tuxiaobei.com/play/940) 返回 HTTP 200、48,124 bytes，并含 `mip-search-video[video-src]`。
6. 详情公开的 CDN URL 形状仍是 `https://resource-cdn.tuxiaobei.com/video/<opaque>.mp4`。使用固定移动 UA、站点 Referer 和 `Range: bytes=0-31` 返回 206、`video/mp4`、32 bytes，字节 4–7 为 `ftyp`。为避免记录 opaque 媒体标识，这里不保存完整媒体 URL。

### 真实失败点

失败不在分类 JSONP、详情选择器、播放器字段或 CDN：这些当前均可读。失败只发生在旧搜索 URL 的 302 自动跟随边界：站点返回未按 HTTP header 安全编码的 Unicode `Location`，`reqwest` 无法构造下一跳请求。

因此不应：

- 放宽全局重定向策略；
- 手工修补或容错任意非 ASCII `Location`；
- 执行远程 JS 来“复现”旧行为；
- 改动详情/播放器选择器或猜测新的媒体头。

### 收口结果与最小改动

[`tuxiaobei_search_url`](../../../src-tauri/src/legacy_http.rs#L3427) 直接生成 `/search/{percent-encoded-key}`，并在 [`maps_tuxiaobei_jsonp_detail_and_explicit_media_contract`](../../../src-tauri/src/legacy_http.rs#L5520) 中覆盖中文、斜杠、问号编码和空关键词拒绝。真实 canary 的搜索断言已加强为非空，并且只使用搜索结果继续 detail→player→MP4 Range。

桌面验证暴露并修复了两个独立边界：

1. renderer 原先按 `.js` 后缀把当前条目交给 QuickJS；现在只把精确 `drpy2(.min).js + 兔小贝 ext` 交给 Rust SourceSession，普通 JavaScript 源不变。
2. 播放入口原先把 HTTP 脚本 API 与 HTTP 详情 ID 误判为 CMS 媒体直通；现在脚本型 API 必须调用源的 `player`，普通 HTTP CMS 直链不变。

当前配置显式声明 `searchable=0`，因此 UI 不应伪造搜索入口。桌面 canary 采用 strict Rust 搜索实际命中的 `/play/940` 作为 direct-detail，播放到 `20.466401s`、`1280×720`、`readyState=4`，并记录 `realHttp=true`、`mockUsed=false`、`tauriPlaybackProxy=true`。这份 artifact 证明同一搜索结果可在桌面播放，不声称 UI 原生搜索已启用。

### 建议验证命令

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::maps_tuxiaobei_jsonp_detail_and_explicit_media_contract -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_tuxiaobei_read_detail_player_media_chain -- --ignored --nocapture --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests -- --test-threads=1
npx --no-install tsx scripts/tauri-cdp-canary.ts --config-url "http://xn--z7x900a.net/" --site-key "儿童" --detail-id "https://www.tuxiaobei.com/play/940" --playback --output artifacts/g123-tuxiaobei-search-result-playback-20260824.json
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

已达成的成功标准：真实 search 非空；所选 ID `/play/940` 来自 search；detail 含明确 `video-src`；player 为 `parse=0`；媒体前缀为 MP4 `ftyp`；桌面 artifact 记录 `realHttp=true`、`mockUsed=false`、首帧、非零尺寸、代理路径和至少 20 秒时钟推进。任何后续失败仍不得退回远程 JS 或降低断言。

门禁边界：兔小贝规范搜索和播放分类精确测试通过，renderer 全文件 `23 passed`，源合同 `27 passed`，类型检查与格式检查通过。legacy_http 最终串行复跑为 `47 passed / 1 failed / 12 ignored`，唯一失败是既有 AppRJ master→raw TS loopback fixture 的第二个 manifest 请求连接失败，精确复跑仍失败；Rust lib 全量三次也有变化的既有 loopback/时序失败。因此不把 legacy/Rust 全量写成绿色，也不在本源切片内扩大到 AppRJ 测试基础设施。

## 第二、第三候选的当前证据

### #2 YGP

2026-08-24 只读复测：[首页](https://www.6huo.com/) 200/47,407 bytes，[分类](https://www.6huo.com/movlist/____1) 200/36,132 bytes、37 个 movie 链接；搜索“机器人总动员”200/14,705 bytes、7 个 movie 链接；本次 `/movie/85440` 暴露 14 个 `/show/{id}`，`/show/195681` 含明确 `.mp4`。仅 UA、无 Referer 的 32-byte Range 返回 206/`ftyp`；带 Referer 返回 403，和当前 Rust player 只保留 UA 的实现一致。[Y][R]

收口复测中，严格 canary 的第一个搜索结果媒体请求失败后，仅在最多 12 个搜索结果的边界内继续，并由 `/movie/83408` 完成 detail→show→`parse=0`→MP4 `ftyp`。同一详情的桌面 direct-detail 播放到 `20.464456s`，总时长 `152.044263s`、`1920×1080`、`readyState=4`、`realHttp=true`、`mockUsed=false`、`tauriPlaybackProxy=true`。配置显式 `searchable=0`，不把 Rust 搜索和桌面 direct-detail 合并表述为 UI 搜索链路。独立审计见 [`G123-YGP-CURRENT-CONTRACT.md`](./G123-YGP-CURRENT-CONTRACT.md)。

### #3 SP360

2026-08-24 只读复测：一方 [rank API](https://api.web.360kan.com/v1/rank?cat=2&callback=qx) 返回 200/30 项；一方 search API 对“流浪地球”返回 200/4 项；detail 返回 200，并提供 6 个 provider 页面。首个 provider 页面是公开 Bilibili bangumi 页面，HTTP 200，但 5,716-byte 静态 HTML 内无 `<video>`、`.m3u8`、`.mp4` 或 iframe，只有 6 个 script 标签。公开原实现 [`SP360.java`](https://github.com/syzxasdc/CatVodTVSpider1/blob/e2ab1f32ba7439cdf4248f1d1b9b823260f5c428/app/src/main/java/com/github/catvod/spider/SP360.java) 也明确让 player 返回 `parse=1`，并未声称直链。[P][R]

严格 canary 现在分别要求 home、category 和 search 非空，不再从分类/首页回退；只在最多 12 个搜索结果、每个最多 24 个真实 episode/provider 页面内寻找可读页面。本次命中 `1|hqPnZhH4R0b3Th`，Bilibili provider 页面返回 5,716 bytes。

桌面 canary 完成原生搜索→详情→六条 provider 线路→`parse=1` 交接，未出现 embedded player 或 playback proxy。默认 Bilibili 静态页面是错误壳；芒果、优酷、腾讯页面分别返回 200 和 69,996/605,145/187,594 bytes，但静态 HTML 同样没有 `<video>`、`.m3u8` 或 `.mp4`。四个隔离 WebView 样本均返回 `WEBVIEW_SNIFFER_IDLE_TIMEOUT`，进程清理正常。脱敏失败证据见 [`g123-sp360-provider-sniff-diagnostic-20260824.json`](../../../artifacts/g123-sp360-provider-sniff-diagnostic-20260824.json)。

这证明固定 API 与页面 hand-off 可用，但不证明媒体可播放。当前没有可验证的 provider 媒体合同，最小且安全的处理是保留 `parse=1` 和失败关闭；不得从页面 URL 推断或伪造媒体直链，也不得为了通过 canary 放开任意跨域资源。

### #4 GuaziTY

当前配置为 `key=瓜子`、`api=csp_GuaziTY`、无 ext，显式 `searchable=0`、`quickSearch=0`、`filterable=1`。因此桌面验收采用 direct-detail，不声明原生搜索。Rust 仍只使用固定 AES-CBC 表单合同、热门/NBA/足球/篮球四类、最近 24 小时且 `m_status < 2` 的赛事，以及详情中无凭据 HTTP(S) `live_line.m3u8`；播放器返回 `parse=0` 和固定 UA/Referer。

2026-08-24 当前篮球赛事 `8466314` 的严格 canary 两次分别取得 2,416,740 与 2,233,064 bytes 的首媒体分片。为缩短直播样本在“取样→桌面”之间失效的窗口，网络 canary 只把尝试顺序改为篮球优先、其余三类继续有界回退；生产分类和过滤代码未改。同一赛事在 Tauri WebView 播放 `20.000929s`，总时长 42s、`1920×1080`、`readyState=4`、`realHttp=true`、`mockUsed=false`。证据见 [`g123-guazity-live-detail-playback-20260824.json`](../../../artifacts/g123-guazity-live-detail-playback-20260824.json)。

HLS.js 使用 `blob:` currentSrc，旧 canary 因只看 invoke trace/currentSrc 把 `tauriPlaybackProxy` 误报为 false；相邻失败诊断明确捕获 `/__qx_playback/` 请求，修正后的证据表达式同时检查 Resource Timing，并有稳定红→绿回归。artifact 透明记录了这一 evidence correction。随后同一 ID 的详情/清单快速失效，`8466316` 的代理清单明确返回 404 `stream not found`；这属于直播时效风险，不能写成全站持续可用。

## 主来源索引

- **[C] 当前配置**：[`http://xn--z7x900a.net/`](http://xn--z7x900a.net/)；2026-08-24 只读获取，解析为 39 个站点。
- **[S] 项目合同状态**：[`docs/source-contract-status.md`](../../source-contract-status.md)。
- **[G] G123 累计报告**：[`docs/reports/goals/G123-REPORT.md`](../goals/G123-REPORT.md)。
- **[R] 当前固定 HTTP 适配器**：[`src-tauri/src/legacy_http.rs`](../../../src-tauri/src/legacy_http.rs)。
- **[A] AppGet/AppQi 适配器**：[`src-tauri/src/app_get.rs`](../../../src-tauri/src/app_get.rs)。
- **[N] native/运行时路由**：[`src-tauri/src/runtime_capability.rs`](../../../src-tauri/src/runtime_capability.rs)、[`src-tauri/src/source_session.rs`](../../../src-tauri/src/source_session.rs)。
- **[T] 兔小贝公开原实现**：[`fantaiying7/EXT/兔小贝.js`](https://github.com/fantaiying7/EXT/blob/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js) 与第一方 [`www.tuxiaobei.com`](https://www.tuxiaobei.com/)。
- **[Y] YGP 第一方端点**：[`www.6huo.com`](https://www.6huo.com/)。
- **[P] SP360 公开原实现和第一方 API**：[`SP360.java`](https://github.com/syzxasdc/CatVodTVSpider1/blob/e2ab1f32ba7439cdf4248f1d1b9b823260f5c428/app/src/main/java/com/github/catvod/spider/SP360.java)、[`api.web.360kan.com`](https://api.web.360kan.com/v1/rank?cat=2&callback=qx)、[`api.so.360kan.com`](https://api.so.360kan.com/)。

## 审计边界

- 本文件没有执行或建议执行远程 JS/JAR/DEX。
- 没有读取 loopback credential 文件、云盘 token 或 Cookie。
- 没有记录任何 AES/key/IV 原值、签名、完整媒体查询串或临时 CDN 参数。
- 审计阶段只提供下一步选择和可验证边界；主线程随后按该边界修改了搜索路径、精确运行时路由、播放入口和稳定测试，并生成脱敏桌面 artifact。
