# G123 YGP 当前合同审计

审计时间：2026-08-24（Asia/Shanghai）。范围仅为当前肥猫配置中的 YGP 站点、第一方站点路径形状，以及本地已验证的 Rust/Tauri 链路。未执行任何 JS、JAR 或 DEX。

## 结论

当前可成立的合同是：配置中有 39 个站点；YGP 条目形状为 `key=豆瓣预告`、`api=csp_YGP`、`searchable=0`、无 `ext`。因此不得把 UI 搜索描述为该配置提供的“原生搜索”；YGP 搜索只能作为受控适配器/验证链路的能力，不能由 `searchable=0` 推导为 UI 原生搜索能力。[当前肥猫配置入口](http://xn--z7x900a.net/)

第一方站点是 `https://www.6huo.com/`。本次只记录路径形状：

- 搜索：`/?keyword=机器人总动员&view=search`
- 详情：`/movie/{数字}`
- 播放页：`/show/{数字}`

第一方搜索当前返回数字 movie 结果；`/movie/83408` 当前返回“奥德赛”详情及多个预告条目，支持上述详情页和预告播放页的路径合同。[第一方首页](https://www.6huo.com/) [第一方搜索页](https://www.6huo.com/?keyword=%E6%9C%BA%E5%99%A8%E4%BA%BA%E6%80%BB%E5%8A%A8%E5%91%98&view=search) [第一方详情页](https://www.6huo.com/movie/83408)

## 合同对照

| 能力 | 当前合同 | 证据与边界 |
| --- | --- | --- |
| 配置 | 39 sites；`豆瓣预告` / `csp_YGP` / `searchable=0` / 无 `ext` | 肥猫配置入口：[http://xn--z7x900a.net/](http://xn--z7x900a.net/)。主线程本轮配置 canary 成功，hash 与上一切片一致；不记录其他配置值。 |
| Home | 读取第一方首页并映射非空结果 | 本地实现 [`legacy_http.rs`](../../../src-tauri/src/legacy_http.rs) 的 `call_ygp` home 分支；加强后的 Rust canary 要求 home 非空。 |
| Category | 读取固定分类页，映射非空结果 | 同一实现的 category 分支；加强后的 Rust canary 要求 category 非空。 |
| Search | 仅在有关键词时请求固定查询形状；只遍历搜索结果 | 查询形状为 `/?keyword=机器人总动员&view=search`。加强后的 Rust canary 要求 search 非空，并只从搜索结果中选择候选，不扩展到全站遍历。 |
| Detail | `movie/{数字}` 详情页解析出线路/剧集 | 当前验证样本为 `/movie/83408`；本地实现拒绝非第一方 host 或非数字 movie 路径。 |
| Player | `show/{数字}` 页面提取直接媒体；`parse=0` | 当前样本完成 detail → show → `parse=0`；媒体仅记录为脱敏的“媒体 host + `.mp4`”，不保存完整 URL 或查询串。 |

## 当前证据

### Rust canary

加强后的实时 canary 要求 `home`、`category`、`search` 各自返回非空列表；搜索候选只来自搜索结果。该 canary 没有把详情页推荐、首页或分类结果混入搜索结果证明，因此其“search 成功”边界是明确的。

### 直接媒体链路

同次搜索的第一个候选在媒体 Range 阶段请求失败；canary 没有降级到首页/分类，而是在最多 12 个搜索结果的边界内继续，当前 `/movie/83408` 已完成：

```text
detail -> show -> parse=0 -> 无 Referer 的 MP4 -> Range bytes=0-31 -> ftyp
```

媒体 URL 的持久化记录只允许保留：`<media-host> + .mp4`；禁止写入完整路径、token、查询串或可复用凭据。

### Tauri 播放

权威本地 artifact [`g123-ygp-search-result-playback-20260824.json`](../../../artifacts/g123-ygp-search-result-playback-20260824.json) 记录：Tauri 对同一详情的 direct-detail 播放观测为 `20.464456s`，媒体总时长 `152.044263s`，分辨率 `1920x1080`，`readyState=4`，且 `realHttp=true`、`mockUsed=false`、`tauriPlaybackProxy=true`。这证明该样本在当前 Tauri 播放代理边界内真实播放；不证明所有 YGP 条目或所有未来媒体 URL 都稳定可播。

## Fail-closed 边界

- 只接受固定第一方 host；详情只能是 `/movie/{数字}`，播放页只能是 `/show/{数字}`。
- 播放页必须能提取直接媒体；动态解析失败即拒绝，不猜测解析器。
- 只接受明确的 `parse=0` 直接播放结果；不把 `searchable=0` 改写成 UI 原生搜索能力。
- 搜索关键词为空时拒绝请求；canary 只遍历搜索返回的有限候选，单个候选失败不扩大扫描范围。
- 直接媒体验收要求 MP4 扩展名、Range 前 32 bytes 可读且 `ftyp` 位于 MP4 标识位置；失败即拒绝播放证明。
- 不附加 Referer；不记录或传播完整媒体 URL、查询串、token、Cookie 或其他敏感配置值。
- 不把本地反编译产物当作公开原实现，也不执行 JS/JAR/DEX。

## 公开 YGP 原实现检索

截至本次审计，未找到可直接引用的公开 GitHub YGP 原实现/源代码文件。已检查公开 CatVod 相关仓库及候选文件路径；没有把搜索结果中的二手配置、文章或转载代码当作来源。仓库内的 `tmp/*YGP.java` 仅是本地静态材料，不作为公开来源，也未执行。

## 剩余风险

- 本轮肥猫配置 canary 成功且 hash 未变化，但下一次配置刷新仍可能改变站点数量或 YGP 条目状态。
- `searchable=0` 与真实 UI 入口之间存在产品语义风险：适配器可以有受控搜索 canary，但不能据此宣称配置启用了 UI 原生搜索。
- 当前播放证据是一个详情样本和一个 direct-detail Tauri 会话；同次搜索的第一个候选媒体请求已经失败，说明它不覆盖其他 movie/show 数字、其他预告、网络波动、媒体过期或站点改版。
- 公开原实现未找到，故不能声称当前 Rust 行为与某个公开 YGP 源码逐行兼容；合同依据应优先来自第一方路径、当前本地实现和实测 artifact。

## 验证命令

以下命令只读取或运行稳定本地测试；实时 canary 需网络和站点可用性，不应作为普通单元测试默认执行：

```powershell
# 查看当前 YGP 合同实现与固定路径校验
rg -n "YGP_BASE|call_ygp|ygp_detail_url|ygp_show_url|YGP_SEARCH_KEY_REQUIRED" src-tauri/src/legacy_http.rs

# 查看权威播放 artifact；该文件不保存媒体 URL
Get-Content -Raw artifacts/g123-ygp-search-result-playback-20260824.json

# 运行 YGP 稳定本地测试（实网项按设计 ignored）
cargo test --manifest-path src-tauri/Cargo.toml --lib ygp -- --test-threads=1

# 运行 CDP 首页证据稳定回归
npx --no-install vitest run tests/tauri-cdp-playback-flow.test.ts

# 仅在明确需要实网复核、且站点可用时运行；结果必须继续脱敏
cargo test --manifest-path src-tauri/Cargo.toml --lib legacy_http::tests::real_ygp_read_detail_player_media_chain -- --ignored --nocapture --test-threads=1

# 当前配置 searchable=0，因此桌面只验证严格搜索选出的同一详情，不声明 UI 搜索
npx --no-install tsx scripts/tauri-cdp-canary.ts --config-url "http://xn--z7x900a.net/" --site-key "豆瓣预告" --detail-id "https://www.6huo.com/movie/83408" --playback --output artifacts/g123-ygp-search-result-playback-20260824.json
```

验收标准：home/category/search 非空；搜索只遍历搜索结果；`/movie/{数字}` → `/show/{数字}` → `parse=0`；无 Referer MP4 Range 前缀包含 `ftyp`；Tauri 证据保持真实 HTTP、非 mock，并且任何输出都不包含完整媒体 URL 或查询串。
