# 声明式 HTTP 源转换器

状态：已实现 Rust 后端最小可用版本，并增加了无 Android Runtime 的专用 HTTP 适配器边界。

这不是 DEX/JAR 反编译器，也不会执行远程 JavaScript。它把一份明确描述了 HTTP 接口的 JSON 规范，转换成现有 `SourceSession` 可以调用的请求计划，并把 JSON 响应映射成播放器当前使用的 TVBox 字段。

## 适用范围

支持：

- HTTP/HTTPS；
- GET、POST；
- URL path、query、header、JSON body 模板；
- JSON Pointer 响应定位；
- 顶层字段和列表项映射；
- `home`、`category`、`search`、`detail`、`player`、`playback` 等会话方法。

不支持：

- Android DEX/JAR、JVM Spider、Python Spider；
- 任意远程 JS 执行；
- HTML/CSS 选择器解析；
- 需要 WBI、AES、动态签名、验证码、登录态或多阶段嗅探的私有算法；
- DRM 绕过。

这些情况必须单独编写受控 Rust 适配器，或进入已经隔离的 QuickJS 边界；不能由转换器猜测。

## 配置格式

把以下 JSON 字符串放入站点的 `ext`，并把站点 `api` 写成对应的 `csp_*` 标识、`type` 写成 `3`：

```json
{
  "qxAdapterVersion": 1,
  "baseUrl": "https://example.test/api",
  "operations": {
    "search": {
      "method": "GET",
      "path": "/search",
      "query": {
        "wd": "{key}",
        "pg": "{page}"
      },
      "response": {
        "root": "/data",
        "fields": {
          "total": "/total"
        },
        "list": {
          "path": "/items",
          "item": {
            "vod_id": "/id",
            "vod_name": "/title",
            "vod_pic": "/cover"
          }
        }
      }
    }
  }
}
```

站点配置示意：

```json
{
  "key": "example",
  "name": "Example HTTP",
  "api": "csp_Example",
  "type": 3,
  "ext": "{...上面的 JSON 字符串...}"
}
```

### 模板参数

模板使用 `{name}` 或 `{object.field}`。参数来自当前 `SourceSession` 的 `params`：

| 方法 | 常用参数 |
| --- | --- |
| `home` | 无或源自定义参数 |
| `category` | `typeId`、`page` |
| `search` | `key`、`page` |
| `detail` | `ids` |
| `player` / `playback` | `id`、`flag`、`episode` 等源自定义参数 |

数组参数会用逗号连接，适合 `ids`。缺少参数会返回 `ADAPTER_PARAMETER_MISSING`，不会静默发送错误请求。

### 响应映射

- `root`：JSON Pointer 根节点；省略时使用整个 JSON。
- `fields`：把源字段复制到统一结果，例如 `vod_name`、`vod_play_from`、`vod_play_url`。
- `list.path`：列表数组路径。
- `list.item`：每个列表项的字段映射。

详情播放至少需要让映射结果包含当前前端使用的 `vod_play_from` 和 `vod_play_url`。如果 profile 结果中的播放地址已经是明确的 HTTP(S) URL，即使没有单独的 `player` 端点，Rust 会直接返回 `parse: 0` 的播放结果并交给现有本地代理；如果适配器声明了自己的 `player/playback` 操作，则优先使用适配器。转换器和 profile 都不会替源站生成播放地址。

播放源聚合器还会交叉检查 `SourceSession` 的 `capabilities.playback`。因此，详情里即使带有线路字段，已声明为元数据、认证或动态播放的来源也只会保留为诊断候选，不会被标记为可播放；能力未知的离线旧调用仍按线路字段处理。

## 编译期专用语义层

`source_semantics.rs` 是转换器之后的一层很小的纯 Rust 结果处理器。它只处理已经由明确 HTTP 契约返回的 JSON/XML 结果，不发请求、不执行脚本、不解密响应，也不把源标识替换成另一个源。

目前编译了 6 个 profile：

- `csp_YGP`：识别 `预告/片花/先导/Trailer/PV` 等已有文本；当结果中确实出现标记时只保留匹配项，否则保留原列表，避免误清空；
- `csp_Config`：只保留具有 `api/url/ext/key/type` 等配置形状的已有条目，并归一为 `vod_id/vod_name`；它对应本地配置操作，明确不提供播放回退；
- `csp_Jpys`、`csp_SP360`：把已有的 `id/title/name/cover/remarks` 别名归一为播放器使用的 `vod_*` 字段；`csp_Gz360` 另有下面的固定 `/Pc` 专用合同，不依赖这一结果 profile；
- `csp_Push`：由独立 URL hand-off 适配器处理；详情 ID 直接生成 HTTP(S) 直连 episode，拒绝本地路径、动态嗅探/解析、YouTube/迅雷和无法验证的字符串。

除 `csp_Config` 外，上述 profile 的播放回退是无状态的：前端传回已选中的 HTTP(S) episode ID，Rust 直接校验并交给现有播放代理，不额外请求源站。因此体积和延迟都很小；相对地，只有相对路径、页面 URL、加密串或需要签名换取真实媒体地址的条目仍不可播放。

这层是“结果语义”，不是“缺失契约补全”。上述 6 个源如果没有真实 `ext` 端点或 `qxAdapterVersion: 1` HTTP 契约，仍会在打开阶段返回 `ADAPTER_CONTRACT_REQUIRED`；`csp_Push` 是例外，它有独立的 URL hand-off 子集，不依赖端点。profile 不会让其他源凭空变成可用源。未命中兔小贝固定 ext 组合的儿童 QuickJS、Android Runtime 和教育别名链路也不受这层影响。

## 运行规则

- 普通 HTTP URL 继续走原有 CMS 链路，不受影响。
- `csp_Douban`、`csp_Jianpian` 继续走现有 native 链路；`csp_Jpys` 走独立的签名 JSON legacy 合同。
- 其他 `csp_*` 只有 `ext` 含 `qxAdapterVersion: 1` 的完整 HTTP 契约才会打开。
- 没有契约时返回 `ADAPTER_CONTRACT_REQUIRED`；不再把未知 `csp_*` 猜成可用源。
- 对明确属于 App/CMS 包装器且 `ext` 提供 HTTP(S) 地址的源，额外有一个很小的
  `auto_http.rs` 兜底：只探测源地址、`/api.php/provide/vod`、`/api.php`、
  `/index.php/api/vod`，只接受可解析的 CMS JSON/XML；配置文本最多跟随一次发现出的 URL。
  这个兜底默认只承诺浏览、分类、搜索、详情；除本地配置 profile 外的 5 个编译期 profile 只有在结果自身带有明确 HTTP(S) 媒体 URL 时才启用无状态直播放回退，仍不猜测 `URL|token` 中 token 的含义。
- 适配器 path 必须是相对路径，不能借模板跳转到另一个绝对 URL。
- 响应大小、请求头、超时和取消仍沿用 `SourceSession` 的安全限制。

## 把现有源转换成可用源的实际步骤

每个源仍需要一份人工确认的契约：

1. 记录 `home/search/detail/player` 的真实 HTTP 方法、路径、参数和必要请求头。
2. 记录真实 JSON 响应结构，填写 JSON Pointer 映射。
3. 在本地测试服务器上先跑 Rust 单元测试，再用真实站点做搜索、详情、播放三段 canary。
4. 只有三段都通过，才把这份 JSON 放进源配置。

当前肥猫配置里的非 native `csp_*` 源没有统一契约，其中一部分依赖 DEX/JAR、动态 JavaScript、HTML 解析、加密响应或源专用签名。因此这个转换器和兜底层只能减少重复 HTTP 胶水代码；对于少量稳定但非 JSON 的源，`legacy_http.rs` 提供单独的 Rust 适配器。它仍不会自动把所有源变成可用源，逐源必须确认真实响应和播放边界。

运行时探针名称 `http-auto` 表示“发现了可探测的端点”，不是线上可用保证；SourceSession 会保留 `http-auto` 标签，让前端知道这是受控 CMS 探测而不是声明式契约。声明式转换器会返回 `http-adapter`。缺少固定 AES key 的 AppGet/AppQi、没有命中专用 Rust 合同的 opaque HTTP `ext` 源可以进入这个受控探测；如果源返回 HTML、加密数据、登录页、错误页或非 CMS JSON/XML，调用会返回 `AUTO_HTTP_CMS_CONTRACT_NOT_FOUND`。固定-key AppGet/AppQi 不会再被编译成声明式 adapter 或 CMS fallback；格式明确但非法的固定-key ext 会报告合同无效。

## 专用适配器的边界

当前专用适配器覆盖：

- `csp_AppGet`：当 ext 明确提供 HTTP(S) base/discovery 地址和 16 字节 AES key/IV 时，走隔离的 Rust AppGet 合同；支持加密列表/详情、一次性 discovery、明确媒体直链和固定 `vodParse`，详见 [`source-contract-appget.md`](source-contract-appget.md)。公开 `./Py/app/getapp.py` 只在固定 `getappapi` + AES key/IV 形状下映射到同一 Rust HTTP 合同：首页 GET、读取/播放表单 POST、固定详情 episode 和 Dalvik 播放头；不执行 Python、不处理验证码或登录。缺少固定 key 时仍保留旧 `http-auto` 边界；动态 HTML/包装页不伪装成播放成功。
- AppGet/AppQi 在协议适配器返回后经过一层纯结果语义：只补齐已有条目的 TVBox 元数据别名，并为已确认的 `parse=0` HTTP(S) 结果补空 `header`；不解密、不请求、不改写或生成播放 URL，解析线路保持原样。
- `csp_AppQi`：复用同一个轻量 AES/JSON 外壳，优先使用 `qijiappapi.index/*`，对公开实现使用的 `getappapi.index/*` 在 404/405 时做一次路径回退；支持 JSON `POST` home、分类过滤、`vodDetail2`、直链与固定 `vodParse` 播放，动态 HTML/包装页和 Android Proxy 弹幕不伪装成成功。
- `csp_AppRJ`：使用 multipart + MD5 的 Rust 合同；详情生成 `name$parseChain|url|ua|vodName|nid` 五段 episode，明确媒体直链可带线路 UA 播放并声明 playback 能力。2026-08-17 真实 Rust canary 完成 `home → category → search → detail → player`，并取到直接 m3u8、嵌套清单和首个 MPEG-TS；动态 `parse_urls` 仍关闭。
- `csp_Jpys`：使用静态确认的 `https://www.hkybqufgh.com` JSON 端点和 `SHA-1(MD5(canonical))` 请求签名；支持固定分类/搜索、详情 `episodeList` 和 `v2/video/episode/url` 直接解析，返回 URL 经 HTTP(S) 校验后 `parse=0`，不调用 Android 本地 Proxy。
- `csp_Push`：使用无网络、无运行时的 URL hand-off 合同；详情 ID 必须是无凭据 HTTP(S) URL，返回一个直连线路，播放器只返回 `parse=0`，嗅探/解析/文件/YouTube/迅雷分支明确关闭。
- `csp_MiSou`：固定候选站点的 `/api/disks` JSON 只读合同，带有界缓存和候选回退；真实 canary 已完成 `home -> search`。返回的网盘分享地址不进入详情或播放，provider 凭据/本地代理缺失时明确关闭。
- `csp_Wwys`、`csp_SaoHuo`、`csp_Duopan`、`csp_Netfixtv`：按已确认的 HTML/文本/分享链接结构做小型适配；SaoHuo 会缓存发布页 `http://shapp.us/` 中严格限制为 `shdy` 数字域名的最新地址，发现失败回退配置 ext；Wwys/SaoHuo 的能力快照允许播放，但只有页面自身暴露无凭据 HTTP(S) 媒体地址时才返回 `parse=0`，不执行远程脚本或猜测解析器；Duopan/Netfixtv 固定使用 MacCMS `type/search/detail` 路径，并按 JSON ext 中的 `site_urls` 顺序回退镜像，详情读取 `module-row-text[data-clipboard-text]` 分享地址，缺少 UC access token 时仍返回认证阻断。
- `csp_Czsapp`：当前 `czzy89.com` 重定向后的站点使用 `/movie_bt`、`/gcj`、`/meijutt`、`/fanju` 分类和 `/movie/{id}.html` 详情；Rust 只过滤真实电影条目，并从 `/v_play/...` 页面 iframe 的 `url/src/file` 查询参数提取明确 HTTP(S) m3u8，不执行外层播放器脚本。能力快照与已有显式媒体提取器一致，但站点 WAF 对 Rust canary 返回 403，且分片探测也被拒绝，因此当前仍不能计为线上可播放。
- `csp_Kanqiu`：固定基址分类、`source` 详情 envelope 和明确 HTTP(S) 直播 URL 可用；`player` 只做 URL hand-off，不执行页面脚本。
- `csp_GuaziTY`：固定 AES-CBC 表单 POST、四个体育分类、24 小时/状态过滤、赛事详情 `live_line` 和固定播放器头已接入；详情中的明确 m3u8 才进入 `parse=0`，真实 canary 还会在最多两层 HLS 清单中取一个首媒体分片，取不到就换下一条线路，全部失败才报错；不执行 Android 运行时。2026-08-24 当前篮球赛事 `8466314` 的首分片取数通过，并在 Tauri WebView 播放 `20.000929s`、`1920×1080`；直播清单随后快速失效为 404，因此只覆盖该时刻样本。
- `csp_Gz360`：固定 `/Pc` AES-CBC JSON POST，支持首页、分类、`Search/GetConditionList` 搜索、详情 `GetVodInfo`、`vurlList` 和明确 m3u8 的 `parse=0` 播放；无凭据/非 HTTP(S) 地址 fail closed。
- `csp_SP360`：固定 `api.web.360kan.com` JSON/JSONP 榜单、分类和详情接口，固定 `api.so.360kan.com` 搜索接口；详情保留多线路/多集 provider 页面，`player` 只返回经过 URL 边界校验的 `parse=1` 页面交接和固定 UA/Referer，由现有受控 WebView 嗅探链继续解析，不把 provider 页面冒充 m3u8，也不执行源内远程脚本。2026-08-24 严格 Rust canary 要求 home/category/search 分别非空，只从搜索结果完成详情、player 与可读 provider 页面；桌面原生搜索和六线路交接成功，但四个 provider 嗅探样本均 idle timeout，未计为媒体播放或首帧。
- `csp_YGP`：固定 `https://www.6huo.com/` HTML 合同，支持 `/movlist/____{page}` 分类、`/?keyword=...&view=search` 搜索、`/movie/{id}` 详情和 `/show/{id}` 预告页；详情只接受同站数字 ID，播放页只从脚本中提取明确 HTTP(S) `.mp4` 并返回 `parse=0`，媒体请求只带固定 User-Agent，不执行远程脚本或带 Referer 请求媒体。2026-08-17 真实 Rust canary 已完成读取→详情→MP4 范围取数。
- `儿童`（兔小贝）：只有 `drpy2.min.js` API 与 ext 明确包含兔小贝脚本名时才命中；固定 `www.tuxiaobei.com` 分类 JSONP、HTML 搜索、数字 `/play/{id}` 详情和 `mip-search-video[video-src]` 媒体提取，返回 `parse=0` 与固定移动 User-Agent/Referer。Rust 不执行远程 `drpy2`/源脚本；2026-08-17 真实 canary 已完成分类→详情→MP4 Range 取数。
- `csp_Kugou`：榜单和歌曲详情可用；2026-08-17 真实复测通过。播放页要求 `infSign` 设备签名并可能进入反刷回调，当前没有稳定、可独立验证的 HTTP 播放契约，明确关闭播放。
- `csp_PanSearch`：Next 数据和双网盘搜索可用；结果 `href` 与封面统一经过 HTTP(S)/无凭据 URL 校验，源本身只提供分享搜索，没有详情和媒体播放链路，明确关闭播放。真实站点若返回 `403` 会原样落入受控错误，不扩大反爬或脚本执行边界。
- `csp_Dm84`：固定 HTML 目录/详情/iframe 播放页解析，并从真实 `http://dm84.pro/` 发布页发现 `dm84.vip`、`dmbus.cc`、`dm84.top` 三个严格白名单候选；候选失败后回退配置 ext。当前内容端点仍返回 HTTP 522，不能宣称线上可用或已完成播放首帧。

这些边界是有意保留的：转换器不执行远程 JavaScript，不反编译 Android DEX/JAR，也不把空结果或动态页面误判为播放成功。

肥猫当前配置中的 AppGet 主站 `cms140.yhg.one` 在 2026-08-16 的验证环境里 TLS 握手失败，明文 HTTP 探测也返回 502；光盘 AppQi 返回 502，行动 AppQi 固定端点建连失败。配置刷新和条目识别可以完成，但 AppGet/AppQi 离线协议夹具通过不等于线上搜索、详情和播放器 E2E 成功；后者仍不能标记为成功。

## 已验证的 HTML 源

`csp_FirstAid` 不适合塞进 JSON-only 转换器，已作为一个独立的、明确白名单的 HTML 适配器接入。它的真实契约和边界见 [`source-contract-first-aid.md`](source-contract-first-aid.md)。
