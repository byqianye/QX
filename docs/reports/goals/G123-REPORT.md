# G123：肥猫 HTTP 源隔离 Rust 适配与受控播放

## 状态

状态：`active`；外部上游部分受阻。AppGet/AppQi/legacy Rust 合同、离线读取与可播放边界已完成，新增 GuaziTY、Gz360 固定 AES JSON 合同、SP360 固定 JSON/JSONP 合同、YGP 固定 HTML 合同、儿童兔小贝固定 JSONP/HTML 合同和 SaoHuo 发布页发现回退，并完成 AppRJ 真实 multipart 播放传输验证，同时更新 Czsapp 当前 HTML 分类/详情路径；GuaziTY/Gz360/AppRJ/YGP/兔小贝完成真实媒体传输取数，SP360 完成真实 provider 页面播放交接，公开备用肥猫配置已支持注释兼容导入并完成原始配置读取→详情→首帧验证，Czsapp 的 Rust 请求被站点 WAF 阻断且分片探测失败。默认肥猫 AppGet/AppQi 上游当前不可达，默认站点的 `home -> search -> detail -> player` 与播放器首帧/时钟验收仍未通过，因此不宣称默认肥猫全站线上可用。

## 依赖

- G109 Rust source session 边界。
- G110 Tauri 播放代理与 `parse=0` 合同。
- G120 肥猫配置刷新和 Jianpian 真实链路 canary。
- 现有声明式 `source_converter.rs`、结果语义 `source_semantics.rs` 与有限 `auto_http.rs`。

## 范围

- 新增只绑定 `csp_AppGet`/`csp_AppQi` 的 `app_get.rs`，不把 AES/签名逻辑塞进通用转换器。
- 配置导入仍以严格 JSON 为快路径；失败时由前端与 Rust 配置目录使用字符串感知扫描器兼容公开配置的 `//`、`/*...*/` 和 `#` 注释，保留 URL/fragment 字符串并对未闭合注释 fail closed。
- 严格解析 pipe/JSON ext，兼容公开对象 ext 的 `host`/`datakey`/`dataiv` 别名；只有绝对 HTTP(S) base 与 16 字节 AES key/IV 才启用。
- 对 AppGet 的 `.txt/.json` pipe 首段、AppQi 的带路径 pipe 首段和 JSON `site` 执行受限一次性 discovery；query/fragment 归一化、重定向和响应大小边界固定。
- 实现 JSON `POST` home/category/search/detail 端点及 AES-CBC/Base64 响应；详情支持 `vodDetail2` 回退，固定 `vodParse` 仍按原协议使用 form body。
- 实现详情线路编码、明确媒体 URL 的无状态直播放和固定 `vodParse` 签名/解密。
- 对确认的固定 `/wmm.php?key&api&url` JSON 解析器增加 64 KiB、无重定向、无脚本的受限 GET；不把其他解析页扩大成通用嗅探。
- 增加 `csp_Push` 的无网络 URL hand-off 专用适配：详情 ID 直接归一成 HTTP(S) 直连 episode，动态嗅探/解析及非 HTTP URL fail closed。
- 增加 `csp_Kanqiu` 的小型 HTML/JSON 适配：固定分类/详情 envelope、`***` episode 分隔符保护和明确 HTTP(S) 直播放；不执行页面脚本。
- 增加 `csp_GuaziTY` 的固定 AES-CBC JSON 体育适配：热门/NBA/足球/篮球分类、24 小时和 `m_status < 2` 过滤、赛事详情 `live_line` 线路，以及固定播放器请求头；只交接明确 HTTP(S) m3u8，不执行 Android 运行时。
- 增加 `csp_Gz360` 的固定 AES-CBC JSON 适配：官方 `/Pc` 首页/分类、搜索端点、详情 `GetVodInfo`、`vurlList`/明确 m3u8 播放和固定请求头；只交接无凭据 HTTP(S) URL，不执行动态解析。
- 增加 `csp_SP360` 的固定 JSON/JSONP 适配：`api.web.360kan.com` 榜单/分类/详情、`api.so.360kan.com` 搜索、多 provider/多集页面线路和固定 `parse=1` 播放页交接；由现有受控 WebView 嗅探继续解析，不把页面 URL 冒充直链。
- 增加 `csp_YGP` 的固定 HTML 适配：`www.6huo.com` `/movlist/____{page}` 分类、`/?keyword=...&view=search` 搜索、`/movie/{id}` 详情、`/show/{id}` 预告页；播放页只提取明确 `.mp4`，返回 `parse=0` 和固定 User-Agent，不执行远程脚本或发送会触发上游拒绝的 Referer。
- 增加儿童兔小贝的固定 Rust 适配：只对 `drpy2.min.js` 与明确的兔小贝 ext 组合命中，使用 `www.tuxiaobei.com` 分类 JSONP、HTML 搜索、数字 `/play/{id}` 详情和 `mip-search-video[video-src]` 明确媒体；返回 `parse=0` 与固定移动 User-Agent/Referer，不执行远程脚本。
- 修正 `csp_SaoHuo` 的站点发现：先读取原 Spider 使用的 `http://shapp.us/` 发布页，严格提取 `shdy` 数字域名并缓存，按候选失败回退配置 ext；发布页、候选主机或媒体 URL 都不执行脚本、不接受凭据。
- 修正 `csp_Dm84` 的站点发现：先读取真实 `http://dm84.pro/` 发布页，严格提取 `dm84.vip`、`dmbus.cc`、`dm84.top` 并缓存，按候选失败回退配置 ext；内容页仍只按固定 HTML/iframe 合同处理，不执行脚本或猜测播放协议。
- 修正 `csp_Duopan`/`csp_Netfixtv` 的镜像选择：读取 JSON ext 的 `site_urls` 数组，按顺序尝试去重后的合法 HTTP(S) 基址；公开读取失败时才切换下一镜像，`player` 仍立即返回 UC 认证阻断。
- legacy Rust 适配器覆盖 AppRJ、Jpys、GuaziTY、Gz360、SP360、YGP、Kanqiu、Wwys、SaoHuo、Czsapp、Duopan/Netfixtv；Czsapp 跟随当前重定向站点的分类/详情路径并提取明确 iframe m3u8，Duopan/Netfixtv 跟随公开 MacCMS `type/search/detail` 路径读取分享 URL，明确媒体直链、动态 parse、UC 认证分别按真实合同处理。
- 分类分页 query 与 base path 分开组装；base 自带的 query/fragment 不会污染固定 API 端点。
- 固定 AppGet 请求禁止自动重定向，避免签名、设备和用户头被带到跳转目标；AppQi 对公开实现的 `getappapi.index/*` 只在旧路径 404/405 时回退一次。
- 固定 AppGet/AppQi 外部端点第一次请求沿用环境代理；连接/超时或代理 `502/503` 时，仅以相同 URL、方法、头和请求体做一次 `no_proxy` 直连重试；loopback 夹具不重复请求，不降级 HTTPS、不改变签名或协议。
- SourceSession 克隆共享 discovery 的成功或失败结果；并发首次调用只发一次 discovery，直链播放不触发 discovery。
- 增加 `csp_MiSou` 的小型 Rust JSON 读取合同：固定三个候选和 `/api/disks`，支持 home/category/search；配置 ext 仍只作为 WangPan provider 配置，不冒充搜索端点，详情/播放明确关闭。
- MiSou 缓存命中请求在锁外并发执行；首次发现或缓存失效后的候选重选在锁内去重。全失败清除旧缓存，并以 compare-and-clear 防止慢失败擦除另一请求的新发现。
- 保留不满足 AppGet 合同的旧 `http-auto` 路径；其他 native、HTML、Bili、legacy、声明式和普通 CMS 路由顺序不变。
- 不执行远程 JavaScript、Android DEX/JAR 或任意解析页面，不绕过登录、验证码、反爬或 DRM。

## 验收标准

- 合成 AppGet HTTP 服务能完成加密 search、detail、直接播放和 `vodParse` 播放。
- SourceSession 能识别 `http-appget` 并把调用路由到专用适配器。
- 能力探针只对合法固定 key ext 声明 AppGet 播放能力；opaque ext 仍保持 `http-auto`、播放 false；显式坏 IV 返回 `APPGET_IV_INVALID` 并保持 fail closed。
- GuaziTY 能力探针声明 `http-json-aes`；离线合同能完成 home、分类字段映射/过滤、详情 `live_line` 和 `parse=0` 播放交接，非法/带凭据地址 fail closed。
- Gz360 能力探针声明 `http-json-aes`；离线合同能完成 AES hex 往返、首页/分类、详情线路和 `parse=0` 播放交接，非法/带凭据地址 fail closed。
- SP360 能力探针声明 `http-json-jsonp`；离线合同能完成 JSONP、榜单/分类、详情多集线路和 `parse=1` 播放页交接，非法/带凭据地址和任意回调包装 fail closed；真实 canary 完成 `home -> category/search -> detail -> player`。
- YGP 能力探针声明 `http-html`；离线合同能完成固定分类/搜索路径、电影详情预告集和显式 MP4 `parse=0`，跨站详情、show 地址、动态脚本和不明确媒体 fail closed；真实 canary 完成 `home -> category/search -> detail -> player` 并取到媒体范围字节。
- 兔小贝能力探针声明 `http-json-jsonp-html`；离线合同能完成固定分类 JSONP、HTML 搜索、数字详情、明确 `video-src` 和 `parse=0` MP4，generic QuickJS/跨站详情/动态媒体 fail closed；真实 canary 完成 `category -> detail -> player` 并取到媒体范围字节。
- 坏 key/envelope/URL/动态 JavaScript fail closed。
- Rust 全量、源测试、类型检查和既有肥猫/Jianpian canary 不回归。
- 真实肥猫 AppGet 或 AppQi 站点完成配置读取、搜索、详情、`parse=0` 播放和播放器 E2E 后，才允许把本 Goal 标记完成。
- MiSou 只在三个真实候选至少一个返回有效 `/api/disks` JSON 后计为线上可读；没有可验证 WangPan provider 合同、凭据和本地代理前，不计为可详情或可播放。

## 验证命令

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib app_get::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib source_session::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib runtime_capability::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run test:sources
npm run typecheck
git diff --check
```

真实 canary：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib config_catalog::tests::real_feimao_config_completes_appget_read_and_player_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib config_catalog::tests::real_feimao_config_completes_appqi_read_and_player_chains -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_guazi_ty_multi_category_detail_player_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_gz360_read_detail_player_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_sp360_read_detail_player_page_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_ygp_read_detail_player_media_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_tuxiaobei_read_detail_player_media_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_czsapp_read_detail_player_manifest_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_apprj_read_detail_player_transport_chain -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_dm84_read_detail_player_chain -- --ignored --nocapture
npx --no-install tsx scripts/tauri-cdp-canary.ts --config-url "http://xn--z7x900a.net/" --site-key "肥猫" --search-key "流浪地球" --playback --output artifacts/feimao-appget-playback.json
npm run test:feimao:canary
```

## 验证结果

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- 2026-08-17 公开固定 Python 包装器 canary：从 `https://raw.githubusercontent.com/heroaku/TVboxo/main/9m.json` 选择精确 `py_肥猫_APP`，真实完成搜索“斗破苍穹”→详情→Tauri WebView 首帧并持续 `20.375s`，视频尺寸 `1920×800`，`realHttp=true`、`mockUsed=false`；证据见 `artifacts/feimao-public-python-wrapper-e2e.json`。该条目只证明固定 `getappapi` HTTP/AES 映射可行，不替换默认域名配置。
- 2026-08-17 默认 `http://肥猫.net/` 配置复测：配置刷新仍得到 39 条旧目录；精确“肥猫” AppGet 在 `home` 返回 `APPGET_HTTP_FAILED`（代理与同 URL `no_proxy` 直连均失败），“光盘” AppQi 在 `home` 返回 `APPQI_HTTP_FAILED`（首个响应为 HTTP 502），均未进入搜索、详情或播放器首帧。
- AppGet/AppQi 专项：本轮 AppGet 36 passed；覆盖当前公开配置 8 个 AppGet/2 个 AppQi ext 形状、固定 Python 包装器、`.txt/.json` discovery、JSON/表单读取、包装器 `home -> search -> detail -> player` loopback AES 夹具、分类过滤字段、两种 discovery、`vodDetail2`/AppQi 路径回退、重复线路、AES、显式坏 key/IV 不降级、opaque token 保留 fallback、直链（含 FLV）、固定 `vodParse` 解密、白名单 `/wmm.php` JSON 解析器、坏 envelope、动态脚本拒绝、重定向拒绝、协议错误前缀隔离、AppQi 不转发 AppGet 专用头、discovery/parser 数字状态码、代理 `502` 后的单次同协议直连重试，以及带环境代理时 loopback fixture 的直连边界。
- legacy_http 专项：35 passed，12 ignored；新增 Dm84 发布页域名白名单与真实读取→详情→iframe 播放页 canary、Duopan/Netfixtv 多镜像候选解析、SaoHuo 发布页域名白名单与直链播放免发现测试、Wwys/SaoHuo/Czsapp 显式 HTML 媒体页 loopback 合同，以及 YGP HTML 目录/详情/显式 MP4、兔小贝 JSONP/HTML 目录/详情/显式 MP4、Duopan/Netfixtv MacCMS 分类/搜索/详情/分享字段和真实读取 canary、SP360 JSONP、榜单/分类、详情多集线路、页面播放页交接和错误输入测试，并保留 GuaziTY/Gz360 AES 往返、赛事/目录过滤、详情线路、固定头播放和 Czsapp 当前分类路径测试。AppRJ 真实 canary 完成 `home -> category -> search -> detail -> player`，直接 m3u8、嵌套清单和首个 849,572 字节 MPEG-TS 均取数成功；动态 `parse_urls` 线路仍 fail closed。GuaziTY 真实 canary 现在按热门/NBA/足球/篮球轮询，找到可播足球赛事，使用固定请求头读取 HLS 清单和首个媒体分片；播放器 URL 日志会去掉临时查询签名，全部线路无清单/分片时显式失败，不把空结果写成通过。Gz360 历史 canary 曾完成首页→分类→详情→明确 m3u8 交接；当前上游状态另行记录；SP360 真实 canary 完成首页→分类/搜索→详情→`parse=1` 播放页交接；YGP 真实 canary 完成首页→分类/搜索→详情→`parse=0` MP4 和首个范围字节取数；兔小贝真实 canary 完成分类→详情→`parse=0` MP4 和首个范围字节取数；Duopan canary 完成首页→分类/搜索→详情并读到 Quark 分享 URL，player 明确返回 `AUTH_REQUIRED`；Czsapp Rust canary 记录站点 WAF `403` 后安全停止，未把网页浏览器探测或分片失败写成播放成功；原有 Kanqiu 分类/详情/直链播放、Wwys 结构和 UC 认证阻断继续通过。
- SourceSession 专项：26 passed；覆盖固定 key AppGet/AppQi 路由、固定 Python 包装器的 `http-appget` 能力、坏包装器 fail closed、Kanqiu/YGP/兔小贝适配能力、Kanqiu/兔小贝直链播放、显式坏 key/IV fail closed、opaque token 仍走 `http-auto`、并发 discovery 去重、失败缓存、直链播放免 discovery，以及 endpointless `csp_Push` 详情/直连播放。
- Runtime capability 专项：17 passed；新增固定 Python 包装器的 `http-appget` 支持和错误路径/key 不降级到 Python；当前肥猫公开 API 集合覆盖审计，并修正 `csp_PanSearch` 的 `http-json-html` 标签；固定 key AppGet/AppQi 声明播放能力，GuaziTY/Gz360 声明 `http-json-aes`，YGP 声明 `http-html`，兔小贝明确组合声明 `http-json-jsonp-html`，显式坏 `dataKey` 报合同无效，opaque 配置保持 `http-auto` / playback false，legacy 对明确直链或固定页面交接的 GuaziTY/Gz360/Kanqiu/AppRJ/SP360/YGP/兔小贝开放播放，其余动态/认证型源关闭，`csp_Push` 使用独立 `http-push` 能力。
- Rust lib 全量：`219 passed / 0 failed / 21 ignored`；新增固定 Python 包装器 loopback AES 读取→播放夹具、SourceSession/runtime capability 边界回归，既有公开配置注释兼容、对象 ext 别名、播放能力门控和播放代理回归继续通过。
- MiSou 相关过滤运行：8 passed；覆盖目录/搜索映射、候选回退和复用、缓存命中并发、全失败清缓存、旧失败不覆盖新发现、SourceSession 专用分派及能力探针。
- 2026-08-18 回归稳定性：串行 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 为 `209 passed / 0 failed / 21 ignored`；公开备用 AppGet canary 已完成 HTTP 206 首段读取，公开原始配置注释兼容导入已完成 Tauri WebView 首帧，公开对象 `host`/`datakey`/`dataiv` 别名只在固定 AES-128 合同下生效，播放源解析器现在会尊重当前/候选会话的 `playback` 能力，Wwys/SaoHuo/Czsapp 只有页面暴露明确无凭据媒体时才允许 HTML 播放，`csp_Config` 明确返回本地配置源边界错误，SP360、YGP、兔小贝、Netfixtv 镜像和 MiSou 搜索真实读取 canary 已通过，Dm84 发布页白名单合同和 SaoHuo 发布页合同通过，Gz360 当前在 `home` 收到 `GZ360_RESPONSE_CODE:0:系统错误` 后安全停止，其他网络 canary 保持 ignored，不把页面交接或上游空结果写成直链媒体成功。
- Gz360 历史线上 canary：官方 `/Pc` AES JSON 首页、`Search/GetConditionList` 搜索、分类、详情和播放器链路曾通过；播放器返回 `parse=0` 和固定 `User-Agent/Referer`，历史媒体取数中 m3u8 返回 HTTP 200、首个 MPEG-TS 分片支持 HTTP 206 Range。2026-08-17 最新复测在 `home` 收到 HTTP 200 的 `GZ360_RESPONSE_CODE:0:系统错误`，官方页面同时显示需先登录；当前不计为线上可用，不绕过登录。
- 兔小贝线上 canary：固定 `www.tuxiaobei.com` 分类 JSONP、`/play/3632` 详情和 `video-src` 播放页通过；播放器返回 `parse=0`、固定移动 `User-Agent/Referer`，CDN MP4 的 `bytes=0-31` 范围请求返回有效 `ftyp` 前缀。该结果只覆盖明确兔小贝 ext 组合，不扩展到其他儿童 QuickJS 脚本。
- AppRJ 线上 canary：Rust multipart + MD5 请求完成 `home -> category -> search -> detail -> player`；直接 m3u8、嵌套清单和首个 MPEG-TS（849,572 字节）均返回成功，动态 `parse_urls` 线路未被执行。
- 2026-08-17 GuaziTY 播放取数 canary：四类分类最多检查 12 场详情，本次足球赛事 `8465736` 返回经日志脱敏的 m3u8；按播放器固定 `User-Agent: Lavf/57.83.100` 和 `Referer: http://WJiZxLXA2.com/` 读取 HLS 清单，并取到首个媒体分片（3,986,164 字节）。这证明读取到媒体数据，但尚未替代桌面 WebView 解码首帧验收；若上游当前没有有效 `live_line`，canary 会显式失败而不是通过。
- 2026-08-18 GuaziTY 播放取数复测：热门分类赛事 `8408339` 完成详情→`parse=0`→HLS 清单→首个媒体分片读取，首个分片约 6,249,308 字节；播放器仍只接受无凭据 HTTP(S) URL 和固定请求头，不把媒体取数写成桌面首帧成功。
- `npm run test:sources`：4 files、27 tests passed。
- `npm run typecheck`：通过。
- `scripts/tauri-cdp-canary.ts`：补充 debug 可执行文件回退、预分配固定 CDP 端口、CDP `/json/list` 超时和非固定 `tauri.localhost` 页面筛选；HLS canary 现在会先切换线路、确认 `aria-selected`，再点击播放按钮；类型检查通过。
- 多源 Tauri 搜索探测现在使用固定 `5_000ms` 超时，仅作用于可用性 `open`、探测 `search/home` 和 Jianpian `init` 的 SourceSession 请求；单源浏览、播放和 QuickJS 合同不变。公开 39 站点配置复测已越过原先长期 `pending=search` 的阻塞。
- 播放代理补齐上游 `206 Partial Content` 的 `Content-Range` 转发；之前公开 MP4 地址虽能 `HEAD 200`，WebView 渐进式播放仍报媒体错误。修复后独立蔬菜 AppGet 和公开 39 站点配置均完成真实首帧与约 20 秒播放。
- `renderer/src/tauri-renderer-api.ts`：多源探测请求带固定 `5_000ms` `timeoutMs`；`tests/tauri-renderer-api.test.ts` 锁定不可用源 `open` 和探测 `search` 的超时合同。
- `src-tauri/src/playback_proxy.rs`：转发 `Content-Range`，并增加渐进式媒体回归测试；修复版 debug 二进制通过真实公开 MP4 播放验证（首帧、`1280×720`、`20.48s`）。
- `src-tauri/src/test_support.rs`：仅测试编译的固定 loopback 端口助手，供 HTTP 夹具复用。
- AppQi 共享错误现在在 `call` 边界统一归一为 `APPQI_*`；AppGet 保持 `APPGET_*`，内部兼容重试仍使用原合同。
- `git diff --check`：通过；只有工作区既有 LF/CRLF 提示。
- SourceSession 能力标签已与运行时探针对齐：声明式转换器返回 `http-adapter`，受控 CMS 探测返回 `http-auto`，普通 CMS URL 仍返回 `http`。
- AppGet/AppQi 客户端对 `localhost`、IPv4/IPv6 loopback fixture 显式绕过环境代理；外部肥猫 URL 仍沿用环境代理设置，避免本地协议夹具被开发机代理误拦。
- `npm run test:feimao:canary`：通过，读取 39 个站点；脱敏统计确认其中 8 个是独立 `csp_AppGet` 条目。
- 2026-08-17 静态取证：配置声明的 Spider 下载物为 864,852 字节 Android DEX 容器，MD5 `f7c90ebd0a6632f3347eeeb8d9bd555e`，与 `tmp/g104-jianpian.jar` 完全同哈希；ZIP 无 JVM `.class`，未执行载荷。AppGet/AppQi 固定路径、AES envelope、字段和播放合同与现有 Rust 主合同一致，没有可据以扩大协议的证据。
- 2026-08-17 外部端点复测：根 `/` 与 `/tv` 仍为同一 40,846 字节配置；默认肥猫 `cms140.yhg.one:443` TCP 超时，光盘 AppQi discovery 成功但 `111.42.67.221:8004` 拒绝连接，行动 AppQi 完成 TLS 后 15 秒内无 `home` 响应；三条均未越过 `home`，search/detail/player 和播放器首帧未执行。
- 固定 AppGet 逐站自适应 canary：`番薯`、`一碗`、`蔬菜`、`方舟` 完成真实 `home -> search -> detail -> player`；`蔬菜` 通过白名单 `/wmm.php` JSON 解析器，`方舟` 通过详情中的明确 `.m3u8` 直链。`肥猫`/`再来` 为 `APPGET_HTTP_FAILED`，`干饭` 为 `APPGET_AUTH_REQUIRED`，当前复测的 `永永` 为 `APPGET_HTTP_STATUS:500`。只有响应前 4 KiB 明确出现 `connection refused`、`localhost:8384` 或 `C#111` 时，才追加 `UPSTREAM_BACKEND_UNAVAILABLE`；对应边界由离线测试覆盖。
- 协议纠正后复跑四个可达 AppGet 源，`番薯`、`一碗`、`蔬菜`、`方舟` 仍全部通过真实读取到 `parse=0` 播放；默认“肥猫”复测仍在 `home` 的 `APPGET_HTTP_FAILED` 连接阶段失败，AppQi“光盘”仍为 `APPQI_HTTP_STATUS:502 Bad Gateway`。
- 同一肥猫配置中的“番薯” AppGet canary：使用搜索词“斗破苍穹”完成 `home -> search -> detail -> player` 全链路；该结果证明专用协议在可达上游上的读取/播放合同可行，但不替代默认“肥猫”站点的播放器首帧验收。
- 2026-08-17 最新定向 canary：同一配置的“番薯” AppGet 仍以真实链路通过；默认“肥猫” AppGet 在 `home` 请求 `cms140.yhg.one` 仍返回 `APPGET_HTTP_FAILED`（代理请求和同 URL 直连重试均失败）；光盘 AppQi 在 `111.42.67.221:8004` 仍返回 `APPQI_HTTP_FAILED`，首个响应为 `HTTP 502`。两条默认源均未进入 search/detail/player。
- 2026-08-17 追加短探测：`cms140.yhg.one` 的 HTTPS/HTTP 固定 `initV119` 均无法建立请求；光盘 discovery 仍只返回单一 `http://111.42.67.221:8004` 且端点不可达，行动 `https://qj4.catbb.xyz` 在 12 秒内无响应；未发现可据以添加的备用路径或协议字段。
- 2026-08-17 Dm84/Wwys 端点复核：`http://dm84.net/` 明确 301 到 `https://dmbus.cc/`，但跳转目标返回 Cloudflare 522；Wwys 的 `http://vip.wwgz.cn:5200/` 只 302 到 HTTPS，当前 HTTPS 内容端点仍不可建立请求。两条均没有足够的响应字段支持新增播放协议或硬编码备用域名。
- 2026-08-17 Dm84 真实读取→详情→iframe 播放页 canary：发布页发现逻辑能进入候选端点，但 `dm84.vip`、`dmbus.cc`、`dm84.top` 及配置回退最终均返回 HTTP 522，canary 在 home 停止；该失败记录为上游不可用，不计为读取或播放成功。
- 2026-08-17 Duopan/Netfixtv 多镜像 canary：按当前 `Duopan2` 配置的五个 `site_urls` 尝试，首个 `http://tvpanpan.site` 完成首页→分类/搜索→详情并读到 Quark 分享 URL；player 明确返回 `AUTH_REQUIRED`，没有把网盘分享页当作媒体。
- 2026-08-17 追加 Netfixtv2 镜像 canary：按当前五个镜像顺序，`https://www.miqk.cc` 完成首页→搜索/分类→详情并读到夸克分享 URL；player 仍返回 `AUTH_REQUIRED`。FeiMaoUC 的 `shandian.blog`、`sd.sduc.site` 均返回 HTTP 522，未扩大协议或凭据边界。
- 2026-08-17 MiSou 真实搜索 canary：`www.misoso.shop` 完成 `home -> search`，返回夸克分享 URL；详情和播放明确返回 provider 凭据阻断，未把分享页伪装成媒体。
- 2026-08-17 Bili 真实 canary 当前在搜索阶段返回 `BILI_HTTP_STATUS:412 Precondition Failed`；未扩大请求头、Cookie 或反爬流程，静态 `search -> view -> playurl` 合同保持不变。
- 2026-08-17 Kugou/PanSearch 复测：Kugou 榜单→歌曲详情和 PanSearch Next 数据→双网盘搜索均通过真实 canary。Kugou 播放页脚本仍要求 `infSign` 设备签名并可能触发反刷回调，未形成可独立验证的静态播放合同；PanSearch 只返回网盘分享搜索结果，没有详情或媒体端点，因此两者继续保持播放关闭。
- 2026-08-17 再次直接运行默认肥猫两个 ignored canary：AppGet `https://cms140.yhg.one/api.php/getappapi.index/initV119` 仍为代理和直连均失败；AppQi `http://111.42.67.221:8004/api.php/qijiappapi.index/initV120` 仍为 `HTTP 502 Bad Gateway`。两次均停在 `home`，没有可据以新增协议或播放器修复的响应字段。
- 2026-08-17 最新默认端到端复测：AppGet canary 仍在 `home` 返回 `APPGET_HTTP_FAILED`（代理与同 URL `no_proxy` 直连均失败）；AppQi canary 仍在 `home` 返回 `APPQI_HTTP_FAILED`，首个响应为 `HTTP 502 Bad Gateway`。两条都没有进入解密、搜索、详情或播放器首帧。
- 2026-08-18 公开备用 AppGet 镜像 canary：公开配置中的 `https://bind.315999.xyz/89.txt|#getapp@TMD@2025|120` 解析到 `https://app7.555618.xyz`，Rust 完成 `home -> search -> detail -> player(parse=0)`，并对明确媒体 URL 取到 HTTP `206` 的首段 32 字节；该证据只证明同协议备用源可用，不替换默认“肥猫”条目。公开配置出处为 [TVboxo/9m.json](https://github.com/heroaku/TVboxo/blob/main/9m.json)。
- 2026-08-18 默认肥猫定向复测：`QX_APPGET_CANARY_SITE=肥猫` 仍在 `home` 返回 `APPGET_HTTP_FAILED`（代理和同 URL 直连重试均失败）；`QX_APPQI_CANARY_SITE=光盘` 仍在 `home` 返回 `APPQI_HTTP_FAILED`，首个响应为 `HTTP 502 Bad Gateway`。两条均未进入解密、搜索、详情或播放器首帧。
- 2026-08-18 公开备用肥猫条目桌面 E2E：直接导入公开 [TVboxo/9m.json](https://github.com/heroaku/TVboxo/blob/main/9m.json)，Rust 配置目录解析 250 个站点，选择精确 `key=肥猫` 的 `csp_AppGet` 条目，真实完成搜索“斗破苍穹”→详情→播放；Tauri WebView 首帧后持续 `20.410s`，视频尺寸 `1280×533`，`mockUsed=false`，证据见 [feimao-public-raw-e2e.json](<C:/Users/qiany/Documents/ChatGPT/QX影视/artifacts/feimao-public-raw-e2e.json>)。同一 ext 为 `https://bind.315999.xyz/89.txt|#getapp@TMD@2025|120`；该证据不替换默认肥猫配置。
- 2026-08-17 备用源逐站复测：`番薯`、`蔬菜`、`方舟` 的 AppGet 均再次完成 `home -> search -> detail -> player(parse=0)`；`一碗` 读到详情但所有候选播放器都返回 `APPGET_DYNAMIC_PLAYER_UNSUPPORTED`；`干饭` 返回 `APPGET_AUTH_REQUIRED`；`再来` 建连失败；`永永` 返回 `HTTP 500`。这证明同一轻量协议在可达上游可复用，但不把认证、动态解析或上游错误伪装成播放成功。
- 2026-08-17 PanSearch 安全回归：结果 `href` 与封面现在统一经过 HTTP(S)/无凭据 URL 校验；离线测试覆盖相对地址、`javascript:`、`data:` 和凭据 URL。真实搜索 canary 本次返回 `403 Forbidden`，没有扩大反爬请求头或执行远程脚本。
- 2026-08-17 发布构建检查：`cargo build --release --lib` 按项目既定门禁拒绝运行，当前环境未提供 `QX_COMPONENT_PUBLIC_KEY_BASE64`、`QX_COMPONENT_MANIFEST_URL`、`QX_COMPONENT_SIGNATURE_URL`；没有伪造密钥或削弱签名保护来测体积。debug Rust 全量测试已完成编译验证。
- 真实 AppGet canary：配置刷新成功，当前 8/8 个 `csp_AppGet` ext 先通过 Rust 专用解析；“肥猫”站点在 `home` 请求 `https://cms140.yhg.one/api.php/getappapi.index/initV119` 时 TLS 握手失败，明文 HTTP 探测也返回 502，因此搜索、详情、播放和播放器首帧/时钟验收均未执行。
- 真实 AppGet canary（加入同协议直连重试后）：默认“肥猫”仍在 `home` 阶段失败，错误同时包含代理请求和 `no_proxy` 直连失败；这不是协议解析失败，当前上游仍不可达。
- 当前公开配置的根路径与 `/tv` 均返回同一 40,846 字节 FongMi envelope（SHA-256 相同），解出的“肥猫”条目仍只有 `https://cms140.yhg.one|<16-byte-key>`，未发现配置内备用端点。
- 真实 AppQi canary：`📀┃光盘┃APP` 的 `home` 返回 `502 Bad Gateway`；`😌┃行动┃APP` 的固定端点建连失败，因此两条均未执行到 search/detail/player；新增的 404/405 路径回退已由离线夹具验证。
- 2026-08-16 继续复测：公开根路径与 `/tv` 仍解析为同一 39 站点配置；`肥猫` 与 `再来` 分别在固定 `home` 端点连接失败，`永永` 的搜索返回 HTTP 500，`干饭` 返回明确的“请登录账号”认证错误，`行动` AppQi 固定端点连接失败。没有发现新的备用端点或协议字段，因此没有添加猜测性路径、跨站备用线路或登录绕过。
- 2026-08-16 定向复测 `QX_APPGET_CANARY_SITE=永永`：搜索阶段稳定返回 `APPGET_HTTP_STATUS:500`，当前代理响应未包含可验证的上游后端标记；实现没有把未知 500 猜测成后端连接拒绝，也没有透传远端 HTML。
- 2026-08-16 复测 `QX_APPGET_CANARY_SITE=方舟`：`home` 在当前网络条件下返回 `APPGET_HTTP_STATUS:403`，桌面 canary 随后停留在 `pending=search` 且没有结果卡片；本轮未生成 HLS 播放 artifact。该结果记录为上游访问策略变化，不扩大请求头、路径或反爬绕过。
- 同日补充探测：`肥猫.live` 与 `我不是.肥猫.live` 返回 HTML 落地页并跳转到夸克分享链接；页面没有稳定的 HTTP/JSON 媒体合同，夸克内容依赖动态页面/客户端获取，因此不扩大现有 Rust 适配、不执行远程脚本，也不把它误报为可播放源。
- Kanqiu 真实 canary：`http://www.88kanqiu.la/` 与 `/match/4/live` 返回 301；跟随到 HTTPS 时本机 TLS 握手失败，线上分类/详情/播放仍待上游恢复后验收，离线合同已通过。
- 2026-08-16 早期复核：Rust 全量 `164 passed / 9 ignored`、源合同 `27 passed`、类型检查通过；“番薯”以“斗破苍穹”完成真实读取到 `parse=0` 播放。该轮 Tauri canary 曾受 WebView2/CDP 和上游搜索阻塞，后续已由多源超时与播放代理修复覆盖。
- 本轮新增复核：AppGet 30 项、SourceSession 21 项、Runtime capability 13 项及前端 HLS/线路回归 3 项均通过；真实桌面 HLS canary 未越过上游搜索阶段，不能替代 20 秒播放器验收。
- 2026-08-16 修复后复核：独立蔬菜 AppGet 与公开 39 站点配置均完成真实桌面搜索、详情、首帧和约 20 秒 MP4 播放（`1280×720`，分别约 `20.48s/20.47s`）；因此通用播放代理合同已通过，默认“肥猫”主站仍受其上游连接失败限制。
- 2026-08-16 最新定向复测：`QX_APPGET_CANARY_SITE=肥猫` 仍在固定 `home` 端点返回 `APPGET_HTTP_FAILED`，代理请求和同 URL 的 `no_proxy` 直连都失败；`QX_APPQI_CANARY_SITE=📀┃光盘┃APP` 先返回 `HTTP 502`，同协议直连重试仍失败。两次都未进入 payload 解密、search、detail 或 player，因此没有可据以新增协议适配的错误响应。
- 2026-08-16 最新合同复核：Rust lib `169 passed / 0 failed / 9 ignored`，`npm run test:sources` 为 `27 passed`，`npm run test:feimao:canary` 成功读取 39 个站点；显式 JSON `dataKey/dataIv` 非法时不再降级成 `http-auto`，旧 opaque `key/token` fallback 保持不变，没有新增猜测性备用线路。
- 2026-08-16 相关 HTTP 合同复测：FirstAid 分类→详情→MP4、Bili 搜索→详情→MP4、Jianpian 三次刷新→搜索→详情→播放、Kugou 分类和 PanSearch 搜索均通过真实 canary；这些成功结果不替代默认“肥猫” AppGet 的上游可达性验收。
- 2026-08-16 外部端点复核：根路径与 `/tv` 仍返回相同的 40,846 字节配置；`hello.xn--z7x900a.net` 返回 Cloudflare `522` 且无配置正文；AppQi discovery `https://yun-1316442804.cos.ap-guangzhou.myqcloud.com/600.txt` 返回单一 `http://111.42.67.221:8004`，没有第二线路。
- 2026-08-16 传输层复核：`cms140.yhg.one` DNS 仅返回 `206.119.174.138`；代理 TLS 握手失败，绕过代理后连接超时。该证据仍落在传输层，不支持新增路径、签名或身份头。
- 2026-08-16 桌面回归尝试：当前 debug 可执行文件启动后未出现可连接的 WebView CDP 页面，canary 以 `TAURI_CDP_PAGE_NOT_FOUND` 终止，未进入配置导入或源请求，也没有生成新播放 artifact；这次失败不计作源失败或播放成功。既有“蔬菜”20 秒 artifact 仍记录历史真实运行，但其临时 debug 二进制当前已不存在，不能替代默认“肥猫”的当前可复现 E2E。

## 修改文件

- `src-tauri/src/app_get.rs`
- `src-tauri/src/auto_http.rs`
- `src-tauri/src/source_converter.rs`
- `src-tauri/src/source_semantics.rs`
- `src-tauri/src/legacy_http.rs`
- `src-tauri/src/push_source.rs`
- `src-tauri/src/misou.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/source_session.rs`
- `src-tauri/src/runtime_capability.rs`
- `src-tauri/src/playback_sources.rs`
- `src-tauri/src/config_catalog.rs`
- `src/config/decoder.ts`
- `tests/config-decoder.test.ts`
- `src-tauri/src/playback_proxy.rs`
- `renderer/src/tauri-renderer-api.ts`
- `tests/tauri-renderer-api.test.ts`
- `scripts/tauri-cdp-canary.ts`
- `docs/source-contract-appget.md`
- `docs/source-adapter-converter.md`
- `docs/source-contract-status.md`
- `docs/spike-19-player-content.md`
- `docs/reports/goals/G123-REPORT.md`
- `artifacts/feimao-public-raw-e2e.json`

## 当前风险与未完成事项

- 2026-08-17，肥猫配置可稳定读取并解出 39 个站点；“肥猫”条目指向的 `cms140.yhg.one:443` TCP 超时，明文 HTTP 探测仍返回 502。该失败发生在传输层，不支持新增路径、签名、身份头或关闭 TLS 校验。
- 2026-08-16 历史网络复测中，“方舟”曾返回 403；该现象不是适配器解密、字段映射或播放器线路选择错误。2026-08-17 复测已恢复到 `parse=0`，仍不添加猜测性身份头、备用路径或反爬绕过。
- 当前配置包含 8 个独立 `csp_AppGet` 条目，脱敏形状统计显示 8/8 具备 16 字节固定 key；实现直接使用配置声明的 key/IV，不猜测 marker 派生算法，也不把这些条目互相当作备用线路。
- “番薯”“蔬菜”“方舟”在 2026-08-17 复测完成读取到 `parse=0` 播放地址解析；“一碗”在动态播放器处安全停止。默认“肥猫”仍未越过上游 `home`，因此默认站点自己的播放器首帧仍未验收；同一公开配置中的“蔬菜”桌面 E2E 已通过。
- CDP 诊断仅保留在 E2E canary：使用进程级 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`、预分配端口、动态数据目录和失败目标快照；没有为生产包静态开放调试端口。
- 肥猫配置中的其他 API 包含 AppQi、AppRJ、Duopan、远程 JS、HTML 和 Android DEX 语义；本 Goal 没有把它们伪装成 AppGet，也没有扩大已有兼容性声明。
- `csp_Dm84` 的 `http://dm84.pro/` 发布页可读取并提供三个白名单候选，但内容端点和配置回退均返回 HTTP 522；因此当前只交付离线 HTML/iframe 合同，未宣称线上读取、直链播放或首帧成功。`csp_Wwys` 仍停在 HTTP→HTTPS 跳转后不可建立内容请求；其能力快照只有在页面暴露明确媒体时才允许播放。
- `csp_Gz360` 已有独立官方 `/Pc` AES JSON 合同和受控 Rust 适配；`csp_SP360` 已根据静态 Spider 字段和当前公开 API 响应接入固定 JSON/JSONP 合同，播放只交接 provider 页面给受控 `parse=1` 嗅探，不宣称直接 m3u8。
- `csp_YGP` 当前公开 MP4 对带 Referer 的请求返回 403，适配器因此只在媒体请求中保留固定 User-Agent；真实 canary 已取到首个范围字节，但尚未替代桌面 WebView 首帧验收。
- Czsapp 已补齐当前重定向站点的分类/详情 HTML 结构和 iframe m3u8 查询参数提取；能力快照与这个显式提取器对齐，但 Rust 真实 canary 被站点 WAF 返回 `403` 后安全停止，且受限分片探测也返回 `403`，因此当前仍未计为线上可播放。Duopan 的公开分享链接可读取到详情，但没有 UC access token bridge，player 始终返回 `AUTH_REQUIRED`。
