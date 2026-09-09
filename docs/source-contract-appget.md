# AppGet / AppQi Rust HTTP 契约

状态：2026-08-24 已实现并通过离线协议夹具；同一肥猫配置中的“番薯”“一碗”“蔬菜”“方舟”已真实完成读取到 `parse=0` 播放链路，“番薯”第 3 条 HLS 线路的指定第 6 集已完成 Tauri WebView 20.514 秒播放，公开备用肥猫原始配置已完成 250 站点导入、精确条目选择、首帧和 20.410 秒播放；默认“肥猫” AppGet 与 AppQi 上游都在 `home` 阶段受阻，因此尚未通过默认站点播放器 E2E。

## 适用边界

这个隔离模块只绑定 `csp_AppGet` 和 `csp_AppQi`，并且只有 `ext` 能明确提供绝对 HTTP(S) 端点和 16 字节 AES key/IV 时才启用。两者共享 AES/响应边界，但端点、请求头和 pipe ext 的元数据严格分开。常见格式是：

公开 TVBox 配置的导入仍以严格 JSON 为快路径；只有严格解析失败时，配置目录和前端解码器才使用字符串感知扫描器去除字符串外的 `//`、`/*...*/`、`#` 注释。字符串中的 `https://`、fragment 和 pipe 元数据不会被改写，未闭合块注释继续拒绝。

```text
https://example.test|0123456789abcdef|119|optional-user-token
```

`csp_AppQi` 的第三段是线路 User-Agent，而不是 AppGet 的版本号/用户令牌：

```text
https://example.test|0123456789abcdef|fixture-agent
```

也接受显式 JSON 对象中的 `url/site`、`dataKey`、`dataIv`、`deviceId`、`version`、`userToken` 和 `ua`。JSON 中非空的 `url/baseUrl/base_url` 优先作为直连 base；空值不会遮住有效的 `site` discovery 地址。缺少固定 key 的旧配置继续进入原有 `http-auto` CMS 探测，不会被误判成加密 AppGet；明确声明的 `dataKey/data_key` 或 `dataIv/data_iv` 非字符串、不是 16 字节时分别返回 `*_KEY_INVALID` / `*_IV_INVALID` 并 fail closed。旧 `key/token` 短值仍视为 opaque 配置并保留原有 fallback，只有满足固定 key 合同时才启用专用适配器。

公开配置中还会把同一合同写成 `./Py/app/getapp.py`（当前可见形状为 `py_肥猫_APP`）。Rust 只接受这个固定脚本路径、`api: "/api.php/getappapi"` 和 16 字节 `datakey/dataiv`；它不执行 Python，也不把其他 `.py` 源降级为可用。`host` 直接指向 API base 时直连，以 `.txt` 或 `.json` 结尾时只做一次受限 discovery。该包装器的 `initV119` 使用 GET，其余首页以外的读取和 `vodParse` 使用表单 POST；详情 episode 只保留 `parse,url,token+token,player_parse_type` 这组已确认字段，播放 URL 仍由固定 AES `vodParse` 响应提供。搜索遇到验证码、登录、反爬或 DRM 时直接返回受控失败，不 OCR、不绕过、不伪造结果。

### 端点发现与缓存

- AppGet pipe ext 的首段路径以 `.txt` 或 `.json` 结尾时，先执行一次 discovery GET；AppQi 对带非根路径的绝对 URL 先执行一次 discovery。JSON 的 `site` 字段同样表示 discovery，直连 `url/baseUrl/base_url` 优先。
- discovery 只接受单个绝对 HTTP(S) 文本 URL、JSON 字符串或 `{"url":"..."}`；空值、HTML/健康文本、多行地址、凭据 URL、嵌套 `.txt/.json` 和非 HTTP(S) 均拒绝。
- discovery URL 保留自身 query、清掉 fragment；解析出的 API base 会清掉 query/fragment，固定端点再独立追加自己的 query。
- discovery GET 禁止重定向，只使用配置声明的 User-Agent，不转发调用方 Cookie、Authorization、AppGet token、设备号或签名；响应上限为 8 KiB。
- `AppGetConfig` 内的共享 `OnceCell<Result<...>>` 在同一 SourceSession 的克隆间缓存成功或失败结果；重新打开会话才会重新 discovery。

## 读取合同

适配器按编译期固定路径发送 POST，请求体为紧凑 JSON，响应必须是 `{ "data": "<base64>" }`。`data` 使用 ext 提供的 AES-128-CBC/PKCS7 key 和 IV 解密后再解析 JSON。

| 会话方法 | 路径 | 请求体 | 读取字段 |
| --- | --- | --- | --- |
| `home` | AppGet `/api.php/getappapi.index/initV119`；AppQi 先试 `/api.php/qijiappapi.index/initV120`，收到 404/405 再试 `/api.php/getappapi.index/initV119` | 空 JSON 对象 `POST`（`{}`） | `type_list`、`recommend_list` |
| `category` | AppGet/AppQi `/api.php/*appapi.index/typeFilterVodList?page=N` | JSON `area/year/type_id/page/sort/lang/class` | `recommend_list` |
| `search` | AppGet/AppQi `/api.php/*appapi.index/searchList` | JSON `type_id/keywords/page` | `search_list` |
| `detail` | AppGet/AppQi `/api.php/*appapi.index/vodDetail`；404/405 时回退 `vodDetail2` | JSON `vod_id` | `vod`、`vod_play_list` |

列表字段被归一为 `vod_id/vod_name/vod_pic/vod_remarks`。详情保留内容、演员、导演、分类，并把 `player_info + urls` 编译成现有播放器使用的 `vod_play_from/vod_play_url`。

读取请求使用紧凑 `application/json; charset=utf-8` body；`home` 发送 `{}`，其余读取请求发送对应 JSON 字段。只有固定 `vodParse` 播放请求仍使用 `application/x-www-form-urlencoded`，并按原协议编码 `url`。AppQi 不携带 AppGet 的设备、版本、用户令牌或签名头。

## 播放合同

- 明确包含 `.m3u8/.mp4/.mkv/.webm/.mov` 的安全 HTTP(S) URL 直接返回 `parse=0`，不再请求源站。
- 普通合法但非媒体的 HTTP(S) episode URL，以及结构化 `parse_api=...&url=...&token=...` payload，只允许请求同一协议 base 下的固定 `vodParse`（AppGet `/api.php/getappapi.index/vodParse`，AppQi `/api.php/qijiappapi.index/vodParse`，404/405 时回退 `/api.php/getappapi.index/vodParse`）。
- 对确认的固定解析器合同 `/wmm.php?key=...&api=...&url=...`，只发一次受限 GET；仅接受 JSON 中的 `url` 媒体字段，响应上限 64 KiB，禁止重定向和页面脚本。该分支覆盖当前“蔬菜”源的真实线路。
- 其他 `.html/.htm` 页面和带 `?url=`/`?key=` 的动态包装页仍需要任意页面解析，适配器明确拒绝，不会误送到 `vodParse`。
- `url=` 值按原协议做一次 form 编码；AppGet 的 `app-api-verify-sign` 是当前 Unix 秒字符串的 AES-CBC/Base64 值，AppQi 不发送该签名。
- 解密后的解析响应只读取 `json.url`、`data.url` 或顶层 `url`，并再次校验为无凭据 HTTP(S) URL。
- 不执行远程 JavaScript，不打开任意解析页面，不扫描 DOM/重定向，不绕过登录、验证码、反爬或 DRM。

## 资源与失败边界

- 没有新增运行时或 sidecar；复用项目已有 `aes`、`cbc`、`base64` 和 `reqwest`。
- 沿用会话的超时、取消、请求头校验和 8 MiB 响应上限；固定 `/wmm.php` 解析器另设 64 KiB 上限。
- discovery 响应另有 8 KiB 上限；超限、失败或取消会缓存为本次会话的失败结果，避免并发调用放大上游故障。
- 固定 AppGet POST 不跟随 HTTP 重定向，避免签名、设备和用户头跨目标传播。
- AppQi 请求边界会剥离调用方带入的 AppGet 设备、版本、时间、签名、UI 和用户令牌头，只保留 AppQi 自己的 User-Agent；坏 JSON ext 和 discovery/parser HTTP 状态也保持 `APPQI_*`/数字状态码合同。
- 固定外部端点第一次请求仍使用进程环境代理；仅在连接/超时或代理返回 `502/503` 时，以相同 URL、方法、头和请求体做一次 `no_proxy` 直连重试。loopback 夹具不重复请求；不会把 HTTPS 降级为 HTTP，也不会改变签名时间或播放协议。
- 肥猫远程配置本身的 GET 使用相同的受限传输策略：连接/超时或代理 `502/503` 才允许一次同 URL、GET 和 User-Agent 的 `no_proxy` 重试；loopback 与 `404` 等非重试状态不旁路，禁止重定向，并保留 8 MiB 上限与最后良好缓存回退。
- key/IV 长度、Base64、AES padding、JSON envelope、HTTP 状态或播放 URL 任一不合法都会显式失败（AppGet 返回 `APPGET_*`，AppQi 返回 `APPQI_*`；显式坏 key/IV 分别为 `APPGET_KEY_INVALID` / `APPGET_IV_INVALID` 和 `APPQI_KEY_INVALID` / `APPQI_IV_INVALID`），不返回空成功。
- 非成功 HTTP 响应只保留数字状态码；如果响应前 4 KiB 明确包含 `connection refused`、`localhost:8384` 或 `C#111`，会追加稳定提示 `UPSTREAM_BACKEND_UNAVAILABLE`，不透传远端 HTML/异常栈。
- AppGet 运行时关键词表来自原宿主，当前没有可靠静态来源；本实现不猜测或硬编码内容过滤词。

## 验证

固定 Python 包装器另有 loopback AES 夹具，验证 `initV119` GET、搜索/详情/`vodParse` 表单 POST、无 AppGet 签名头、详情 episode 编码和 Dalvik 播放头；原有下方计数是修改前基线，本轮新增后分别为 AppGet/AppQi 36 项、SourceSession 26 项、Runtime capability 17 项。

离线测试覆盖 ext 解析、当前公开配置 8 个 AppGet/2 个 AppQi ext 形状、公开对象 `host`/`datakey`/`dataiv` 别名、AppGet/AppQi discovery、已知 AES 向量、JSON POST home、分类过滤字段、`vodDetail2` 和 AppQi 路径回退、重复线路名、直链播放（含 FLV）、两种 `vodParse` 签名/解密、固定 `/wmm.php` 解析器、JSON/表单编码边界、显式坏 key/IV 不降级、opaque token 保留 fallback、坏 envelope、动态脚本拒绝、重定向拒绝、协议错误前缀隔离、AppQi AppGet 头隔离、数字 HTTP 状态码，以及 loopback fixture 在环境代理存在时仍直连；配置目录/前端解码器另覆盖公开注释、URL fragment 保留和未闭合注释拒绝。测试夹具使用仅在 `#[cfg(test)]` 下编译的固定端口助手，避免 Windows 动态端口/TIME_WAIT 造成假失败。当前专项计数为 AppGet/AppQi 32 项、SourceSession 21 项、Runtime capability 15 项。真实 canary 会先刷新 `http://xn--z7x900a.net/`，再分别验证肥猫 AppGet、光盘 AppQi、行动 AppQi 的 `home -> search -> detail -> player`；公开原始备用配置另有真实 Tauri WebView E2E artifact。

2026-08-24 复测中，`cms140.yhg.one` 经系统 DNS、`1.1.1.1`、`8.8.8.8` 均解析为 `206.119.174.138`，但 HTTP/HTTPS 直连都超时；光盘 AppQi 发现到 `http://111.42.67.221:8004` 后请求失败，行动 AppQi 固定端点建连失败。同配置“番薯”“方舟”及使用可播放内容结果的“蔬菜”仍能完成 Rust `home -> search -> detail -> player(parse=0)`；其中“番薯”搜索“哪吒”后，指定第 3 条“优选八号”HLS 与第 6 集已在 Tauri WebView 真实推进 `20.513818s`，媒体总时长 `754.173332s`、`1920×1080`，artifact 同时确认 DOM 实际选中 `lineIndex=2`、`episodeIndex=5`，证据为 `artifacts/g123-feimao-fanshu-nezha-line3-ep6-20260824.json`。脱敏详情显示四条线路均为 26 集且没有默认、排序或健康字段，因此继续保留上游顺序，不按线路名猜优先级；播放器回退仅保留其他线路中同名的当前集，避免跨集跳转。修复后同一线路/选集再次真实推进 `20.058713s`，证据为 `artifacts/g123-feimao-fanshu-nezha-line3-ep6-fallback-20260824.json`。首选 MP4 第 1/6 集仍只返回相同的 `6.687007s` 短媒体，第 2 条 HLS 起播超时，因此通过范围不扩大到其他线路，也不能替换默认站点。公开原始备用配置的真实 E2E artifact 为 `artifacts/feimao-public-raw-e2e.json`，也只证明其明确 `csp_AppGet` ext 当前可达。AppQi 原 Android 版本还会把 `vodName/nid` 交给其本地 Proxy 生成弹幕地址；当前 Rust 弹幕服务只接受显式数据，不抓取该 Proxy URL，因此本适配器不伪造 `danmaku` 能力。
