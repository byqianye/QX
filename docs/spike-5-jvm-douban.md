# Spike 5: JVM-native csp_Douban minimum port

## Result

The minimum `csp_Douban` home path is portable to JVM-native code.

`DoubanJvmSpider` implements the extracted `init(ext)`, `homeContent(filter)`,
and `destroy()` contract with JDK 21 `HttpClient`. It has no Android, Gson, or
CatVod runtime dependency. The existing URLClassLoader + reflection host and
NDJSON sidecar load it as `com.qx.spike.fixture.DoubanJvmSpider`.

This is deliberately a minimum slice: `homeContent` is ported; category,
detail, search, and play paths are not yet ported.

## Extraction from Douban.java

The local JADX output was inspected from the public DEX artifact selected by
the existing config probe. The relevant constants decode as follows:

- Base API used by most category branches: `https://frodo.douban.com/api/v2`.
- Embedded API key: `0ac44ae016490db2204ce0a042db2916`.
- The exact `homeContent` source URL is
  `http://api.douban.com/api/v2/subject_collection/subject_real_time_hotest/items`
  with that key.
- The working desktop URL used by this Spike is the same path on
  `https://frodo.douban.com`. The old HTTP host returned 403 in this
  environment; the HTTPS Frodo endpoint returned 20 items.
- Headers extracted from the source are `Referer` and a WeChat desktop
  `User-Agent`. Java's HTTP client supplies the host and connection handling.

The seven home classes are preserved, including the leading space in the first
name because it is present in the decompiled source:

| type_id | type_name |
| --- | --- |
| `hot_gaia` | ` 热门电影` |
| `tv_hot` | `热播剧集` |
| `show_hot` | `热播综艺` |
| `movie` | `电影筛选` |
| `tv` | `电视筛选` |
| `rank_list_movie` | `电影榜单` |
| `rank_list_tv` | `电视剧榜单` |

The home response reads `subject_collection_items`. Each item is mapped using
the same fields as `Douban.java`:

| Source field | CatVod field |
| --- | --- |
| `id` | `vod_id = msearch:<id>` |
| `title` | `vod_name` |
| `pic.normal` | `vod_pic` plus the source's Referer/User-Agent suffix |
| `rating.value` | `vod_remarks = 评分：<value>` |

The original `homeContent(boolean)` does not use the boolean flag. The minimum
port keeps that behavior and returns `class` plus `list` JSON. The encrypted
filter definition is decoded and understood, but is intentionally not emitted
until the category-content slice is implemented.

For the JVM contract, `init(ext)` treats `ext` as an optional HTTP(S) endpoint
override; an empty value selects the working HTTPS default above. This keeps
the endpoint choice outside the Spider implementation when the service moves.

The category method also exposes enough plain endpoint structure to support a
later slice:

- `movie/hot_gaia?apikey=...&sort=<sort>&area=<area>&start=<offset>&count=20`
- `subject_collection/<type>/items?apikey=...&start=<offset>&count=20` for
  `tv_hot`, `show_hot`, and the two ranking classes
- `tv/recommend?apikey=...&sort=<sort>&tags=<encoded tags>&start=<offset>&count=20`
- `movie/recommend?apikey=...&sort=<sort>&tags=<encoded tags>&start=<offset>&count=20`

The obfuscation is not a blocker for these paths: the helper is cyclic XOR and
the network/JSON call is a normal HTTP request. The remaining work is behavior
porting, not Android execution.

## Verification

The local contract test uses a response shaped like the extracted Douban API
and verifies the class/list field mapping:

```text
npx vitest run tests/douban-jvm.test.ts
```

The real sidecar probe was run on Windows x64 with JDK 21:

```text
npm run spike:douban
```

Observed result:

- `status: passed`
- `classCount: 7`
- `listCount: 20`
- sample `vod_id: msearch:36721173`
- sidecar process stopped cleanly after `destroy()`

The existing generic JVM tests still cover request timeout termination and
process isolation. This Spike adds the real Douban request on top of that same
sidecar path.

## Runtime decision

For the minimum `csp_Douban.homeContent` path, continue with JVM-native
porting. An Android Emulator/DEX Spike is not justified by the evidence from
this path: the endpoint, response fields, and required obfuscation were
recovered reliably, and the real request completed in the JVM sidecar.

The public artifact remains Android DEX and cannot be loaded by JDK 21. The
existing Java probe also found no connected Android device/emulator. That is a
separate compatibility fact, not a blocker for this hand port.

The desktop MVP therefore does not need two engines just to support
`csp_Douban`. Keep the DEX engine as an optional future adapter only for spiders
whose Android-only APIs or unrecoverable runtime behavior prevent a JVM-native
port; do not make both engines a requirement of the current design.
