# Spike 7：选片到详情的可行性验证

## 结论

这次验证拆开了两个问题：

1. 原始 `csp_Douban` DEX 是否提供 CatVod 的详情/搜索实现；
2. Douban 当前接口是否足以支撑一个新的 JVM-native 详情实现。

结论是：

- DEX 没有覆写 `detailContent`、`searchContent` 或 `playerContent`。
- `msearch:<id>` 只是在首页/分类条目映射时生成的 `vod_id`，DEX 内没有把它路由到详情的方法。
- 当前 Frodo 详情接口可用：`/api/v2/movie/<id>` 和 `/api/v2/tv/<id>`。
- 详情字段足够生成 CatVod 风格详情：ID、标题、封面、评分、类型、年份、导演、演员、简介、上映日期；TV 还提供集数信息。
- 在 Spike 7 的忠实适配范围内不需要新增 `detail` RPC，因为原 DEX 本身没有详情逻辑。若产品要求点击后展示详情，则应把它定义为 JVM-native 扩展，再新增 RPC，而不是声称完成了原 DEX 的 `detailContent` 适配。

## 1. DEX 方法覆写

对 `com.github.catvod.spider.Douban` 的 JADX 输出检查到的方法为：

| 方法 | DEX 自身实现 | 说明 |
| --- | --- | --- |
| `init(Context, String)` | 是 | 保存配置并初始化请求环境 |
| `homeContent(boolean)` | 是 | 返回分类与首页条目 |
| `categoryContent(String, String, boolean, HashMap)` | 是 | 返回七个分类路由的条目 |
| `detailContent(List<String>)` | 否 | 继承 CatVod `Spider` 默认空实现 |
| `searchContent(String, boolean[, String])` | 否 | 继承 CatVod `Spider` 默认空实现 |
| `playerContent(...)` | 否 | 继承 CatVod `Spider` 默认空实现 |

因此，不能把这个 DEX 当作“首页/分类/详情/搜索完整 Spider”加载。它的可验证业务表面目前止于分类列表。

## 2. `msearch:<id>` 的进入路径

逆向得到的条目映射逻辑把 Douban 条目的数字 ID 转成：

```text
vod_id = "msearch:" + item.id
```

例如：

```text
msearch:36721173
```

在已提取的 Douban 源码和本地 CatVod `Spider` 基类源码中，没有发现 `msearch:` 的解析器或特殊详情分派。对当前 DEX 能下的结论是：

- `msearch:<id>` 是输出给宿主的条目标识，不是 `Douban.detailContent` 的调用协议；
- 直接对这个 DEX 调用 `detailContent` 只会落到基类默认空结果；
- 是否由某个 Android 宿主在 UI 层识别 `msearch:`，需要继续检查具体宿主 App 的详情分派代码，不能从 `csp_Douban` 本身推断。

## 3. 详情接口与字段

本 Spike 用真实条目 ID 做了两次请求：

- 电影：`36246195` → `https://frodo.douban.com/api/v2/movie/36246195`
- TV：`36721173` → `https://frodo.douban.com/api/v2/tv/36721173`

请求必须保留 DEX 中的微信小程序 `Referer` 和 `User-Agent`；使用普通浏览器/Android UA 时，本次探测得到 `invalid_request_997`。

两条当前路径均返回 HTTP 200。可用字段如下：

| CatVod 详情用途 | Frodo 字段 |
| --- | --- |
| ID、标题、年份 | `id`, `title`, `year` |
| 封面 | `cover_url`；响应中同时有 `pic`/`cover.image` |
| 评分 | `rating.value`, `rating.count` |
| 类型、地区、语言 | `genres`, `countries`, `languages` |
| 导演、演员 | `directors[].name`, `actors[].name` |
| 简介 | `intro` |
| 上映日期 | `pubdate` / `release_date` |
| TV 集数 | `episodes_count`, `episodes_info`, `last_episode_number` |
| 站内链接 | `uri`, `url`, `info_url` |

兼容性对照：

- Frodo 的 `/api/v2/movie/subject/<id>` 本次返回 404；
- 旧 `api.douban.com/v2/movie/subject/<id>` 本次返回 `invalid_credencial2`（code 109）。

因此后续 JVM-native 详情实现应使用按媒体类型分流的 Frodo 路径，不应复用旧的 `/subject/<id>` 路径。

可复跑探针：

```text
npm run spike:douban-detail
```

可通过 `QX_DOUBAN_MOVIE_ID`、`QX_DOUBAN_TV_ID` 替换测试 ID。

## 4. sidecar 决策

在 Spike 7 完成时，`src/spider/rpc.ts` 的通用方法枚举已经包含 `detail`，但 JVM 具体实现尚未暴露它：

- `JvmSidecar` 目前只有 `init/home/category/destroy` 的类型化调用；
- `JvmSpiderHost` 目前也只反射 `init/homeContent/categoryContent/destroy`；
- JVM `Spider` 接口没有 `detailContent` 方法。

因此 Spike 7 当时暂不新增 `detail` RPC；原 DEX 没有可移植的详情实现可供保持一致。

Spike 8 已实现下面的 JVM-native `detailContent` 扩展：

```text
detailContent(ids) -> Frodo /api/v2/{movie|tv}/{id} -> CatVod detail JSON
```

它属于新业务能力，不应标记为原 `csp_Douban.detailContent` 的还原；下一步可以评估 `searchContent`。

## 判定

`csp_Douban`：可 JVM-native 移植首页和分类；详情/搜索不是 DEX 的能力。

Douban 详情数据：当前可用，足以支持后续 JVM-native 详情扩展。

Android Emulator/DEX：本 Spike 不需要启动。只有在必须复现 Android 宿主对 `msearch:` 的私有分派，或后续遇到 Android-only 签名/请求行为时，才值得单独投入。
