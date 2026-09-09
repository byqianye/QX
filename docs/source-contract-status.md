# 源 HTTP 契约验证结论

验证日期：2026-08-24（累计）

## 已验证并接入

| 源 | 后端契约 | 已验证链路 | 结论 |
| --- | --- | --- | --- |
| `csp_Douban` | Rust native JSON | 现有 native 单测 | 保持现有能力，不宣称播放 |
| `csp_Jianpian` | Rust native HTTP | 现有 native 单测/历史 canary | 保持现有完整链路 |
| `csp_FirstAid` | Rust HTML HTTP | `/jijiu` 分类 → `/jijiu/article/...` 详情 → MP4 | 可用；搜索、分页不支持 |
| `csp_Bili` | Rust JSON HTTP | 搜索 → `view` 详情 → `playurl` `durl` MP4 | 可用；只承诺 MP4，不承诺 WBI/DASH/会员链路 |
| `csp_Kanqiu` | Rust HTML/JSON HTTP | 固定站点分类 → `source` 详情 envelope → 直播 URL | 离线合同支持直播放；当前站点 HTTP→HTTPS 重定向后 TLS 握手失败，未计入线上可用 |
| `csp_Kugou` | Rust HTML HTTP | 榜单 → 歌曲详情 | 可浏览；当前播放接口未形成稳定契约，播放关闭 |
| `csp_PanSearch` | Rust JSON/HTML HTTP | 首页 Next 数据 → 两个网盘搜索接口 | 搜索可用；该源无详情/播放链路 |
| `csp_MiSou` | Rust JSON HTTP | 固定候选 `/api/disks` 的 home/category/search，真实搜索 canary 通过 | 目录和搜索已接入；详情/播放依赖 WangPan provider、凭据和本地代理，明确关闭 |
| `csp_AppGet` | Rust 加密 HTTP | 离线 home/category/search/detail + 直链/vodParse/wmm.php 播放夹具；“番薯”“一碗”“蔬菜”“方舟”曾通过真实链路；“番薯”第 3 条 HLS 的指定第 6 集完成 Tauri WebView 20.514 秒播放；公开备用镜像 canary 完成读取→详情→`parse=0`→Range；公开原始配置进一步完成 250 站点导入、精确条目选择和 Tauri WebView 20 秒播放 | 合同已接入；默认肥猫主站 HTTP/HTTPS 当前均连接超时；公开备用镜像 `bind.315999.xyz/89.txt`（解析到 `app7.555618.xyz`）2026-08-18 取到 HTTP 206 首段 32 字节，并以同一 ext 完成真实首帧/20.410 秒播放，但不替换默认配置 |
| `csp_AppQi` | Rust 加密 HTTP | 离线四个读取端点 + 直链/vodParse 播放夹具 | 光盘线上 home 返回 502；行动线上端点建连失败 |
| `csp_AppRJ` | Rust multipart JSON | `home → category → search → detail → player` 真实 canary；2026-08-24 当前 NBY media playlist 与首个 PNG+TS 包装段完成结构校验，桌面真实解码到 `1920×818` 并推进约 `5.96s` | 直链播放可用；只允许精确白名单 NBY parser，保留线路 UA；前端保留完整 `parseChain\|target\|UA\|vodName\|nid` 交接，代理仅允许 NBY 分片一次跳转到无凭据公开 `.png`。样本第二分片返回 404，尚未通过 20 秒桌面门槛 |
| `csp_Jpys` | Rust 签名 JSON HTTP | 固定端点分类/搜索 → `video/detail` → `episode/url` 真实 canary | 已接入；请求使用静态确认的 `MD5→SHA-1` 签名，episode URL 直接 `parse=0`；不使用 Android 本地 Proxy |
| `csp_GuaziTY` | Rust AES-CBC JSON HTTP | 四类体育分类 → 赛事详情 → `live_line` m3u8 → `parse=0`；当前清单/分片与桌面 20 秒播放通过 | 已接入；仅保留最近 24 小时且 `m_status < 2` 的赛事，播放地址和固定请求头均经边界校验；2026-08-24 篮球赛事 `8466314` 首分片取数通过，同一详情在 Tauri WebView 播放 `20.000929s`、`1920×1080`、`readyState=4`。配置 `searchable=0`，桌面采用 direct-detail；直播清单随后在分钟级失效为 404，因此只覆盖验收时刻样本 |
| `csp_Gz360` | Rust AES-CBC JSON HTTP | 历史 `/Pc` 首页/分类/`Search/GetConditionList` → `GetVodInfo` → m3u8/Range 取数；当前复测停在 home | 已接入；固定 JSON body/envelope、无凭据 HTTP(S) URL 和请求头均经边界校验；历史 canary 曾完成媒体取数，但 2026-08-17 当前上游返回 HTTP 200 `code=0,msg=系统错误`，官方页面要求登录，不能绕过登录，故当前不计为线上可用或首帧通过 |
| `csp_SP360` | Rust JSON/JSONP HTTP | `api.web.360kan.com` 榜单/分类 → `api.so.360kan.com` 搜索 → `/v1/detail` 详情 → provider 播放页 `parse=1`；2026-08-24 严格搜索 canary 到可读 provider 页面通过 | 已接入；固定 API、JSONP 回调、字段和无凭据 HTTP(S) 播放页均经边界校验。严格 canary 要求 home/category/search 分别非空，只遍历搜索结果及其 provider 页面；当前“流浪地球”命中 `1|hqPnZhH4R0b3Th`，Bilibili provider 页面返回 5,716 bytes。桌面原生搜索/详情/六线路交接成功，但受控 WebView 未捕获媒体，Bilibili/芒果/优酷/腾讯样本均为 `WEBVIEW_SNIFFER_IDLE_TIMEOUT`，故不宣称直接 m3u8、首帧或可播放 |
| `csp_YGP` | Rust HTML HTTP | `www.6huo.com` `/movlist/____1` 分类、`/?keyword=...&view=search` 搜索 → `/movie/{id}` 详情 → `/show/{id}` 明确 MP4；2026-08-24 严格搜索 canary 与桌面 20 秒播放通过 | 已接入；固定站点路径、电影/预告字段和同站 show URL 经边界校验，播放页脚本只提取明确 HTTP(S) `.mp4`，返回 `parse=0`；严格 canary 要求 home/category/search 各自非空且只使用搜索结果，当前 `/movie/83408` 的 MP4 Range 32 bytes/`ftyp` 通过，并在 Tauri WebView 播放到 `20.464456s`、`1920×1080`、`readyState=4`。不执行远程 JS、不带 Referer 请求媒体 |
| `儿童`（兔小贝） | Rust JSONP/HTML HTTP | `www.tuxiaobei.com` `/list/mip-data?typeId=&page=&callback=` 分类 JSONP、`/search/{percent-encoded-key}` 搜索 → `/play/{id}` 详情 `mip-search-video[video-src]` → CDN MP4；2026-08-24 严格搜索 canary 与桌面 20 秒播放通过 | 已接入；仅在 `drpy2(.min).js` 与 ext 明确指向兔小贝脚本时命中专用合同，renderer 将该精确组合交给 Rust SourceSession，脚本型 API 不再被播放入口误判为 CMS 直链；搜索结果 `/play/940` 的 CDN MP4 在 Tauri WebView 播放到 `20.466401s`、`1280×720`、`readyState=4`。不执行 `drpy2` 或远程 JS，不扩展到其他儿童 QuickJS 脚本 |
| `csp_Push` | Rust URL hand-off | URL 详情 → 直连 episode → `parse=0` | 可用；仅 HTTP(S) 直连，嗅探/解析/文件/YouTube/迅雷分支关闭 |
| `csp_Czsapp` | Rust HTML HTTP | 当前站点重定向后的 `/movie_bt`、`/gcj`、`/meijutt`、`/fanju` → `/movie/{id}.html` → `/v_play/...`；iframe `url/src/file` 明确 m3u8 提取 | 已接入；导航链接过滤、当前分类路径和显式媒体提取器均有离线合同；传输错误和 408/425/429、500/502/503/504、520–524 仅重试一次。2026-08-24 真实 canary 在最多 10 个候选中读取到首个 HLS 分片 463,854 字节，随后 Tauri WebView 第 1 集播放到 20.097 秒、1440×604、`readyState=4`；《九门》旧清单分片仍返回 403，因此线上可播放只覆盖已验收条目，不代表全部内容健康 |
| `csp_Wwys`、`csp_SaoHuo`、`csp_Duopan`、`csp_Netfixtv` | Rust HTML HTTP | Wwys 当前 ext 返回 404/缺少模板；SaoHuo 原 Spider 的 `shapp.us` 发布页可解析 `shdy2.com`/`shdy3.com`，源请求按候选回退；Duopan/Netfixtv 公开页面均复现 MacCMS 分类、搜索、详情和分享字段，Rust canary 在 Duopan 镜像通过 | Wwys/SaoHuo 只有页面直接暴露无凭据 HTTP(S) 媒体时才播放；当前内容站仍返回 404/Cloudflare 522，因此不宣称线上可读；Duopan/Netfixtv 可读取到详情分享 URL，云盘播放仍需 UC access token，播放器明确返回认证阻断；不把分享页伪装成媒体 |

## 本轮继续验证

- 2026-08-17 公开固定 Python 包装器：从 `https://raw.githubusercontent.com/heroaku/TVboxo/main/9m.json` 选择精确 `py_肥猫_APP`，Rust 只按固定 `getappapi` + 16 字节 AES key/IV 形状映射，真实完成搜索“斗破苍穹”→详情→Tauri WebView 首帧并持续 `20.375s`，视频尺寸 `1920×800`，`realHttp=true`、`mockUsed=false`；证据见 `artifacts/feimao-public-python-wrapper-e2e.json`。不执行 Python，不处理验证码、登录、反爬或 DRM。
- 2026-08-17 默认 `http://肥猫.net/` 配置复测：刷新仍得到 39 条旧目录；精确“肥猫” AppGet 在 `home` 返回 `APPGET_HTTP_FAILED`（代理与同 URL `no_proxy` 直连均失败），“光盘” AppQi 在 `home` 返回 `APPQI_HTTP_FAILED`（首个响应 HTTP 502），因此默认域名条目仍未通过搜索、详情、播放器首帧验收。
- 2026-08-24 Czsapp：Rust canary 要求详情、显式 HLS 清单及首个分片都成功，当前候选读到 463,854 字节分片；Tauri WebView 对同一详情的第 1 集播放到 `20.097033s`，视频 `1440×604`、`readyState=4`、`realHttp=true`、`mockUsed=false`。artifact 明确记录 direct-detail、具体 `detailId` 和 `nativeSearchAndDetail=false`。公开 Spider 静态实现的新旧版本最终均返回 `parse=0` 且媒体头为空，因此没有猜测性增加 Referer/Cookie，也没有执行 JAR/DEX 载荷。
- 2026-08-24 兔小贝：真实 Rust canary 要求搜索结果非空，并只使用搜索命中的 `/play/940` 继续详情、`parse=0`、CDN MP4 Range 206/`ftyp`；Tauri WebView 对同一详情播放到 `20.466401s`，视频 `1280×720`、`readyState=4`、`realHttp=true`、`mockUsed=false`、`tauriPlaybackProxy=true`。当前配置显式 `searchable=0`，所以桌面采用 direct-detail，仅 Rust canary 证明规范搜索路径；不把该 artifact 写成原生 UI 搜索证据。
- 2026-08-24 YGP：真实 Rust canary 分别要求首页、分类和搜索非空，只遍历搜索结果继续 detail→show→`parse=0`→MP4 Range，并断言字节 4–7 为 `ftyp`；当前第一个结果的媒体请求失败后，第二个 `/movie/83408` 成功，证明候选内容健康会波动。Tauri WebView 对同一结果播放到 `20.464456s`，总时长 `152.044263s`、`1920×1080`、`readyState=4`、`realHttp=true`、`mockUsed=false`、`tauriPlaybackProxy=true`。当前配置同样显式 `searchable=0`，桌面采用 direct-detail，不声明 UI 原生搜索。
- 2026-08-24 SP360：当前配置 `key/api=csp_SP360`、无 ext，`searchable` 未声明。严格 Rust canary 不再以分类或首页结果掩盖搜索失败，只从“流浪地球”搜索结果继续详情和 provider 页面，当前 Bilibili 页面读取 5,716 bytes。Tauri 桌面完成原生搜索、详情、六线路和 `parse=1` 交接，但默认 Bilibili 页面是无媒体标记的错误壳；Bilibili、芒果、优酷、腾讯四个隔离 WebView 样本均在同源受控策略下 idle timeout，未观察到媒体或播放器代理。失败证据见 `artifacts/g123-sp360-provider-sniff-diagnostic-20260824.json`；没有放宽跨域策略、执行 Android 运行时或伪造直链。
- 2026-08-24 GuaziTY：当前配置 `key=瓜子`、`api=csp_GuaziTY`、无 ext 且 `searchable=0`。将实网 canary 的分类尝试顺序改为当前更快产生活跃样本的篮球优先，但仍在四类内有界回退；生产过滤、AES、详情和播放器合同不变。当前 `8466314` 的 HLS 首分片两次分别读取 2,416,740 与 2,233,064 bytes，同一详情桌面播放 `20.000929s`、总时长 42s、`1920×1080`、`readyState=4`。随后该 ID 的详情或清单快速失效，另一个 `8466316` 清单明确返回 404，证明分钟级直播时效风险。证据见 `artifacts/g123-guazity-live-detail-playback-20260824.json`。

## 本轮新增转换/适配层

- `app_get.rs`：只绑定有固定 16 字节 key/IV 的 `csp_AppGet` 与 `csp_AppQi`，按协议隔离 GET/POST 端点、表单编码请求体、请求头、pipe/JSON ext（含公开对象形状的 `host`/`datakey`/`dataiv` 别名）、discovery、AppQi 路径回退、`vodDetail2`、详情线路编码、明确媒体直链、固定 `vodParse` 和白名单 `/wmm.php?key&api&url` 解析器；外部固定端点在连接/超时或代理 `502/503` 时做一次同协议 `no_proxy` 直连重试，loopback 夹具不重复请求。离线合同已验证；默认肥猫真实 AppGet/AppQi 上游当前不可达，未计入默认站点线上可用源。
- `config_catalog.rs` 与 `src/config/decoder.ts`：严格 JSON 失败后才按字符串边界去除公开目录的 `//`、`/*...*/`、`#` 注释，保留 URL fragment 和 pipe 元数据；未闭合块注释保持 `CONFIG_JSON_INVALID`，缓存保存清理后的合法 JSON。远程配置 GET 在连接/超时或代理 `502/503` 时只做一次同 URL/方法/User-Agent 的 `no_proxy` 重试，loopback 和 `404` 等非重试状态不旁路，仍禁止重定向并受 8 MiB 上限约束。
- `source_converter.rs`：无运行时声明式 HTTP/JSON 转换器，适合明确提供 `qxAdapterVersion: 1` 契约的源。
- `source_semantics.rs`：编译期纯 Rust 结果语义层，覆盖 `csp_YGP`、`csp_Config`、`csp_Jpys`、`csp_Gz360`、`csp_SP360`、`csp_Push` 的筛选和字段归一；显式 HTTP(S) URL 播放回退只用于真实提供媒体交接的 profile，`csp_Config` 保持本地配置、不可播放。
- `auto_http.rs`：体积很小的受控 CMS 探测器，覆盖带 HTTP `ext` 的 App/CMS 包装器；只做有限路径尝试和一次配置 URL 发现，不执行脚本、不解密源专用协议；普通源不承诺播放，6 个 profile 仅在结果自身有明确媒体 URL 时直播放。
- `legacy_http.rs`：不依赖 Android、JVM 或 QuickJS 的小型 Rust 专用适配器，覆盖 `Dm84`、`Kanqiu`、`Kugou`、`PanSearch`、`AppRJ`、`Jpys`、`GuaziTY`、`Gz360`、`SP360`、`YGP`、`儿童/兔小贝`、`Wwys`、`SaoHuo`、`Czsapp`、`Duopan`/`Netfixtv`；Czsapp 绑定当前 HTML 分类/详情路径，只从 iframe 查询参数提取明确媒体 URL，并仅对瞬时传输错误和白名单 HTTP 状态做一次重试；YGP 绑定 `6huo.com` 的固定分类/搜索/详情路径，只从同站 show 页面脚本提取明确 `.mp4`；兔小贝只绑定明确的 `drpy2 + 兔小贝 ext` 组合，使用 percent-encoded `/search/{key}`、固定分类 JSONP、详情 `video-src` 和 CDN 媒体，renderer 的精确运行时路由与播放入口共同保持这条 Rust 合同；Duopan/Netfixtv 绑定 MacCMS `type/search/detail` 路径并读取 `module-row-text[data-clipboard-text]` 分享地址；Jpys、GuaziTY、Gz360 只使用固定确认的签名/AES JSON 端点并对明确 HTTP(S) 媒体 URL 直播放，SP360 只使用固定 JSON/JSONP API 并把公开 provider 页面交给现有受控 `parse=1` 嗅探；动态解析、UC 认证和不明确地址都 fail closed。
- `push_source.rs`：绑定 `csp_Push` 的 URL hand-off 合同；不需要远程端点，详情 ID 直接归一为受限 HTTP(S) 直连 episode，动态嗅探/解析和非 HTTP URL fail closed。
- `misou.rs`：按原 Android 实现固定三个候选和 `/api/disks?page=N[&keyword=Q]`，只映射目录/搜索字段；缓存命中请求在锁外并发执行，首次发现或失效重选才串行去重，全失败会清除失效缓存。配置中的 `kk.txt` 是 WangPan provider 配置，不作为搜索端点；云盘详情/播放保持关闭。
- `csp_Dm84` 已有离线 HTML 契约解析和请求路径；当配置 ext 是 `dm84.net`/`dm84.tv` 时，先读取真实 `http://dm84.pro/` 发布页，只接受 `dm84.vip`、`dmbus.cc`、`dm84.top`，再回退配置 ext。当前内容端点仍返回 HTTP 522，未计入真实可用源，也没有把未经发布页确认的域名硬编码成播放备用。
- `csp_Duopan`/`csp_Netfixtv` 的 JSON ext 多镜像现在按 `site_urls` 顺序尝试，公开 MacCMS 读取 canary 已从 `tvpanpan.site` 读到详情和 Quark 分享 URL；UC access token 仍缺失，播放明确返回 `AUTH_REQUIRED`。

## 受控探测但仍未确认真实契约的源

缺少固定 AES key/IV 或仅有 opaque token 的 AppGet/AppQi 配置，以及没有命中专用 Rust 合同的其他 HTTP `ext` 源，仍可进入 `http-auto`。这只是把可探测端点交给标准 CMS JSON/XML 校验；没有通过真实响应校验的源仍然不可用。已识别的 AppRJ、Wwys、SaoHuo、Czsapp、Duopan/Netfixtv 不再伪装成通用 CMS 播放能力。

固定 key/IV 的 `csp_AppGet` 不再进入 CMS 猜测，而是优先走 `http-appget`；坏的固定-key ext 在能力探针和会话打开阶段都会 fail closed。当前配置刷新可解出 39 个站点，其中 8 个 `csp_AppGet` 条目是彼此独立的站点/密钥/内容目录，且脱敏形状统计显示 8/8 都具备 16 字节固定 key，不能互相当作备用线路。其离线 `home/search/detail/player` 合同已通过；肥猫配置中的 `cms140.yhg.one` 当前连接失败，因此仍不能列为线上已验证可用。

## 仍不能写入真实契约的源

以下源没有端点、依赖不可用的 Android DEX/JAR、依赖远程 QuickJS、或当前站点失效，不能诚实地强行写成 Rust HTTP 契约：

`csp_Config`、线上仍返回 522 的 `csp_Dm84`，以及未命中兔小贝固定 ext 组合的其他儿童 QuickJS 远程脚本。`儿童` 的兔小贝条目已移入上面的固定 JSONP/HTML Rust 合同，但不执行其 `drpy2` 或任意远程 JS；`csp_YGP` 已移入上面的固定 HTML Rust 合同；`csp_SP360` 已移入上面的固定 JSON/JSONP Rust 合同；`csp_Gz360` 已移入固定 `/Pc` Rust 合同；`csp_Push` 已有独立的 URL hand-off 子集，但不等于原 Android Spider 的嗅探/解析能力。

本轮对 `csp_Config` 等无固定端点标识保留编译期结果语义 profile，但 `csp_Config` 不再启用显式 URL 播放回退；并为 `csp_YGP`、`csp_Push` 增加独立 HTML/URL hand-off 适配；`csp_SP360` 则使用已经确认的固定 API 和受控页面播放合同。其余源没有真实端点时仍不能打开，有明确 HTTP 结果且结果自身包含 HTTP(S) 媒体地址时才会做筛选、字段归一和播放。

不对这些源猜测接口、不反编译 DEX、不把超时/空结果当作成功。`csp_少儿`、`csp_小学`、`csp_初中`、`csp_高中` 的 API 实际都是 `csp_Bili`，因此已走 Rust Bilibili HTTP 链路；它们的教育别名/专用内容筛选不等于已恢复原 Android Spider 语义。

## 验证结果

- Rust 历史全量与专项已覆盖 SP360 JSONP、YGP HTML 目录/详情/显式 MP4、Duopan/Netfixtv MacCMS 分类/详情/分享字段、榜单/分类、详情多集线路、页面播放页交接和 fail-closed 测试，并保留 GuaziTY/Gz360 AES 往返、赛事/目录过滤、详情线路、固定头播放和 Jpys 签名/详情 episode 覆盖；MiSou 覆盖映射、候选回退、缓存复用、缓存命中并发、全失败清缓存和旧失败不覆盖新发现；AppGet 专项继续覆盖固定 `/wmm.php` 解析器、当前公开 ext 形状、显式坏 AES key/IV 不降级、AppQi AppGet 头隔离和数字 HTTP 状态码。2026-08-24 当前全量门禁状态见下述最新结果，不沿用历史全绿数字。
- 2026-08-18 Rust 全量回归：`209 passed / 0 failed / 21 ignored`；新增公开备用 AppGet 读取→详情→直链媒体 canary、公开原始配置注释兼容导入与未闭合注释拒绝、公开对象 `host`/`datakey`/`dataiv` 别名合同、当前肥猫公开 API 集合覆盖审计和 `csp_PanSearch` 的 `http-json-html` 能力标签回归，另有播放源解析器 `playback` 能力门控回归、Wwys/SaoHuo/Czsapp 显式 HTML 媒体页 loopback 合同、`csp_Config` 本地源边界回归、Gz360 上游错误消息边界回归、MiSou 真实搜索 canary 和 Dm84 发布页白名单离线合同，loopback 测试夹具改用仅测试编译的固定端口助手，消除了 Windows 动态端口/TIME_WAIT 假失败，不影响生产请求路径。
- MiSou / SourceSession / Runtime capability 专项：`6 / 24 / 15` 项全部通过；MiSou 相关过滤运行共 `8 passed`（含跨模块分派和能力测试）。
- 2026-08-24 兔小贝定向：规范搜索与脚本 API 播放分类两个 Rust 精确测试通过，严格实网 canary 只使用搜索结果 `/play/940` 完成详情、player 与 MP4 Range，renderer 全文件 `23 passed`。legacy_http 前次串行曾为 `48 passed / 12 ignored`；最终复跑为 `47 passed / 1 failed / 12 ignored`，唯一失败是既有 AppRJ master→raw TS loopback fixture 的第二个 manifest 请求连接失败，精确复跑仍失败。Rust lib 全量三次也出现变化的既有 loopback/时序失败，因此当前不声明 legacy/Rust 全量绿色。
- 2026-08-24 YGP 定向：`cargo test --lib ygp` 为 `4 passed / 1 ignored`，严格网络 canary 单独运行通过；CDP 首页证据回归先复现“第一张卡无图、后续卡有已解码海报”的阻塞，再改为分别取第一条非空标题和同一可见首页中的第一张已解码海报，完整测试文件 `8 passed`。`npm run test:sources` 为 4 files / `27 passed`，`npm run typecheck`、`cargo build`、`cargo fmt --check` 与 `git diff --check` 通过。
- 2026-08-24 SP360 定向：`cargo test --lib sp360` 为 `3 passed / 1 ignored`，严格实网 canary 单独运行通过，证明当前 home/category/search 非空、搜索结果详情可形成 `parse=1` 且 provider 页面真实可读；桌面搜索→详情→线路交接可复现，但播放器等待超时，四次 runtime sniffer 均 fail closed 且无残留进程。CDP 辅助测试 `8 passed`，`npm run test:sources` 为 4 files / `27 passed`，`npm run typecheck`、`cargo build --bin qx-yingshi`、`cargo fmt --check` 与 `git diff --check` 通过；不把失败诊断计为桌面播放通过。
- 2026-08-24 GuaziTY 定向：`cargo test --lib guazi` 为 `5 passed / 1 ignored`；严格实网 canary 在篮球优先顺序下通过，并由同一赛事完成桌面 20 秒播放。HLS.js `blob:` currentSrc 导致代理证据初始误判的回归先红后绿，CDP 辅助测试为 `9 passed`；`npm run test:sources` 为 4 files / `27 passed`，`npm run typecheck`、`cargo build --bin qx-yingshi`、`cargo fmt --check` 与 `git diff --check` 通过。不会把清单随后 404 隐藏为全站稳定。
- `npm run test:sources`：4 个文件、27 项通过。
- `npm run typecheck`：通过。
- AppQi 共享错误在 `call` 边界归一为 `APPQI_*`；AppGet 保持 `APPGET_*`，不改变内部重试和 fail-closed 行为。
- AppGet/AppQi 非成功响应使用稳定数字状态码；已确认的上游 `localhost:8384` 连接拒绝只映射为 `*_HTTP_STATUS:500:UPSTREAM_BACKEND_UNAVAILABLE`，不把远端 HTML 错误页当作协议响应。
- 肥猫配置 canary：读取 39 个站点并脱敏确认 8 个独立 `csp_AppGet` 条目。
- 固定 AppGet 逐站自适应 canary：`番薯`、`蔬菜`、`方舟` 在 2026-08-17 复测完成真实 `home -> search -> detail -> player(parse=0)`；`一碗` 曾读到详情但当前在动态播放器处安全停止。`肥猫`/`再来` 为连接失败，`干饭` 为 `APPGET_AUTH_REQUIRED`，`永永` 为 HTTP 500。
- 同一配置中的“番薯” AppGet canary：真实完成 `home -> search -> detail -> player`；仅证明可达 AppGet 上游的专用合同可行，不替代默认“肥猫”站点验收。
- 2026-08-17 最新复测：“番薯”仍完成真实 `home -> search -> detail -> player`；默认“肥猫” AppGet 仍在 `home` 返回 `APPGET_HTTP_FAILED`，光盘 AppQi 仍在固定端点返回 `HTTP 502`，均未进入播放链路。
- 2026-08-17 追加短探测：默认 AppGet 的 HTTPS/HTTP `initV119` 均未建立连接；光盘 discovery 仍只有 `http://111.42.67.221:8004`，行动端点在短超时内无响应；没有新增备用协议证据。
- 肥猫 AppGet 真实链路 canary：配置刷新成功，当前 8/8 个 `csp_AppGet` ext 均通过 Rust 专用解析；命名“肥猫”的条目在 `home` 请求阶段建连失败，search/detail/player 与播放器首帧未执行。
- 肥猫 AppQi 真实链路 canary：`📀┃光盘┃APP` 的 `home` 返回 `502 Bad Gateway`；`😌┃行动┃APP` 的固定端点建连失败；两条均未执行到 search/detail/player。
- 2026-08-17 最新默认端到端复测仍停在 `home`：AppGet `cms140.yhg.one` 的代理与同 URL 直连重试均失败，AppQi 光盘端点仍返回 `502`；没有可据以新增协议或播放修复的响应字段。
- 2026-08-18 公开备用 AppGet 镜像 canary：公开配置中的 `https://bind.315999.xyz/89.txt|#getapp@TMD@2025|120` 解析到 `https://app7.555618.xyz`，Rust 完成 `home -> search -> detail -> player(parse=0)`，并对明确媒体 URL 取到 HTTP `206` 的首段 32 字节；该证据只证明同协议备用源可用，不替换默认“肥猫”条目。
- 2026-08-18 默认肥猫定向复测：AppGet `肥猫` 在 `home` 返回 `APPGET_HTTP_FAILED`（代理和同 URL 直连重试均失败）；AppQi `光盘` 在 `home` 返回 `APPQI_HTTP_FAILED`，首个响应为 `HTTP 502 Bad Gateway`；两条均未进入解密、搜索、详情或播放器。
- 2026-08-18 公开备用肥猫条目桌面 E2E：复用公开 [TVboxo/9m.json](https://github.com/heroaku/TVboxo/blob/main/9m.json) 的同一 AppGet ext，以最小合法 JSON 导入后完成搜索→详情→播放；Tauri WebView 首帧后持续 `20.448s`，视频尺寸 `1280×533`，`mockUsed=false`，详见 `artifacts/feimao-public-mirror-e2e.json`。公开原文件含注释，不能直接作为严格 JSON 导入；该测试不替换默认肥猫配置。
- 2026-08-18 公开原始肥猫配置桌面 E2E：直接导入公开 [TVboxo/9m.json](https://github.com/heroaku/TVboxo/blob/main/9m.json)，Rust 配置目录解析 250 个站点，选择精确 `key=肥猫` 的 `csp_AppGet` 条目，真实完成搜索“斗破苍穹”→详情→播放；Tauri WebView 首帧后持续 `20.410s`，视频尺寸 `1280×533`，`mockUsed=false`，详见 `artifacts/feimao-public-raw-e2e.json`。该证据不替换默认肥猫配置。
- 2026-08-24 复测：默认配置仍为 39 个站点；“肥猫” AppGet 的 `cms140.yhg.one` 在 HTTP/HTTPS 均连接超时，“光盘” AppQi 发现到 `111.42.67.221:8004` 后请求失败，“行动” AppQi 固定端点也连接失败。相同配置中的“番薯”“方舟”和以“凡人修仙传”命中可播放结果的“蔬菜”完成 Rust `home -> search -> detail -> player(parse=0)`。“番薯”首页得到 127 张卡片和 `400×566` 首卡海报；首选 MP4 第 1/6 集均只播放 `6.687007s`，但精确选择第 3 条“优选八号”HLS 和第 6 集后，桌面真实播放推进 `20.513818s`，总时长 `754.173332s`、`1920×1080`、`readyState=4`，DOM 实际选中 `lineIndex=2`、`episodeIndex=5`，且无 mock，证据为 `artifacts/g123-feimao-fanshu-nezha-line3-ep6-20260824.json`。该通过结论不覆盖默认“肥猫”、AppQi 或“番薯”的其他线路。
- 2026-08-24 多线路回退复核：番薯真实详情的四条线路均为 26 集且没有上游默认/排序/健康字段，因此适配层不按“优选”名称猜线路。播放器回退候选已从“所有其他集数”收紧为“其他线路中同名的当前集”，避免第 6 集失败后跳到第 1 集并在三次上限内耗尽；修复后同一“优选八号”第 6 集再次真实推进 `20.058713s`，证据为 `artifacts/g123-feimao-fanshu-nezha-line3-ep6-fallback-20260824.json`。
- 2026-08-24 GuaziTY 复测：篮球赛事 `8466314` 完成详情→`parse=0`→HLS 首分片读取，并由同一详情完成桌面 WebView `20.000929s` 播放。直播清单随后快速 404，当前结论不覆盖其他赛事或后续时刻。
- 2026-08-17 备用 AppGet 复测：`番薯`、`蔬菜`、`方舟` 再次完成 `home -> search -> detail -> player(parse=0)`；`一碗` 在动态播放器处安全停止，`干饭` 为 `APPGET_AUTH_REQUIRED`，`再来` 建连失败，`永永` 为 `HTTP 500`。默认“肥猫”主站仍未越过 `home`。
- 2026-08-17 PanSearch 结果 URL 已增加 HTTP(S)/无凭据校验；本次真实 canary 返回 `403`，因此仍只声明搜索合同，不声明播放。
- 2026-08-17 MiSou 真实 canary：`www.misoso.shop` 完成 `home -> search` 并返回夸克分享 URL；详情/播放保持 provider 凭据阻断。
- 2026-08-17 Bili 真实 canary 当前在搜索阶段返回 `BILI_HTTP_STATUS:412`；不新增猜测性身份头或反爬绕过，保持已确认的 MP4 合同边界。
- FirstAid 真实 canary：通过。
- Bilibili 真实 canary：历史复测曾通过；2026-08-17 当前搜索返回 `412`，未扩大反爬边界。
- Kanqiu 真实 canary：当前基址 HTTP 返回 301，HTTPS 握手失败；分类、详情、播放尚未完成线上验收。离线合同已覆盖固定详情 envelope 和直链播放。
- Kugou 真实 canary：榜单、详情通过；2026-08-17 复测仍通过。播放页依赖 `infSign` 设备签名与反刷回调，未形成稳定静态 HTTP 合同，播放明确关闭。
- PanSearch 真实 canary：Next 数据和双网盘搜索通过；源本身没有详情或媒体端点，播放明确关闭。
- Jpys 真实 canary：固定签名搜索、详情和 `episode/url` 解析通过，返回 `parse=0` HTTP(S) 地址；不依赖 Android 本地 Proxy。
- AppRJ 真实 canary：multipart + MD5 的 `home → category → search → detail → player` 通过；当前 parser 顶层已是 media playlist，首个分片为 69 字节完整 PNG 后接 4,355 个对齐 MPEG-TS packet。白名单 NBY parser、线路 UA 和完整 episode handoff 已接入；桌面无需剥离 PNG 即真实解码并推进约 5.96 秒，但样本第二分片 404，未计为 20 秒 E2E 通过。
- GuaziTY 线上 canary：真实请求按篮球/热门/NBA/足球有界轮询，当前赛事 `8466314` 完成 `category -> detail -> player`；播放器返回 `parse=0` 和固定 `User-Agent/Referer`，HLS 首个媒体分片读取成功，并在桌面 WebView 播放 20 秒。该排序只缩短时效样本的验收窗口，不改变生产源分类顺序或过滤语义。
- Gz360 线上 canary：历史复测曾完成官方 `/Pc` AES JSON 首页、搜索、分类、详情、`parse=0` 播放和 m3u8/Range 媒体取数；2026-08-17 最新复测在 `home` 返回 HTTP 200 `code=0,msg=系统错误`，当前源按上游/登录边界安全停止，未宣称播放成功。
- Wwys/SaoHuo 线上复测：Wwys 的当前 ext 首页是 404 页面、分类/搜索返回缺少模板文件；SaoHuo 发布页可返回 `shdy2.com`/`shdy3.com` 候选，但这些内容站和旧 ext 当前均为 Cloudflare 522，因此 Rust 只增加受限发现与回退，不把候选当作线上成功。
- Duopan/Netfixtv 线上复测：两组公开 MacCMS 页面均完成首页→分类→搜索→详情结构复现，详情稳定提供 Quark/Baidu/UC 等分享 URL；Rust canary 在 Duopan 镜像验证首个分享地址，未尝试云盘登录或令牌交换，`player` 保持 `AUTH_REQUIRED`。
- 2026-08-17 Netfixtv2 镜像复测：当前第五个镜像 `https://www.miqk.cc` 完成首页→搜索/分类→详情并返回夸克分享 URL；FeiMaoUC 两个镜像均为 HTTP 522。云盘分享仍不进入直播放。
- `cargo fmt --check`：通过。
- `tmp/`：本轮未触碰。
