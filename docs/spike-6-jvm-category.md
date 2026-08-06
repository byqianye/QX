# Spike 6: JVM-native csp_Douban categoryContent

## Scope

Spike 5 proved `homeContent`. This slice adds the extracted
`categoryContent(typeId, page, filter, extend)` contract to the JVM host and
sidecar.

The public JVM seam is:

```text
categoryContent(String typeId, int page, boolean filter, Map<String,String> extend)
```

The RPC method is `category`; its parameters are `typeId`, `page`, `filter`,
and `extend`.

## Route mapping

All seven classes from `Douban.java` are implemented:

| type_id | endpoint | response array |
| --- | --- | --- |
| `hot_gaia` | `/movie/hot_gaia` | `items` |
| `tv_hot` | `/subject_collection/<type>/items` | `subject_collection_items` |
| `show_hot` | `/subject_collection/<type>/items` | `subject_collection_items` |
| `movie` | `/movie/recommend` | `items` |
| `tv` | `/tv/recommend` | `items` |
| `rank_list_movie` | `/subject_collection/<榜单>/items` | `subject_collection_items` |
| `rank_list_tv` | `/subject_collection/<榜单>/items` | `subject_collection_items` |

The extracted filter behavior is preserved:

- `hot_gaia`: `sort` defaults to `recommend`; `area` defaults to `全部`.
- `tv_hot` and `show_hot`: `type` selects the subject collection.
- `movie` and `tv`: `sort` defaults to `T`; all non-`sort` values become the
  comma-separated URL-encoded `tags` value, matching the original helper.
- The two ranking classes: `榜单` selects the subject collection, with the
  original movie/TV realtime defaults.

For every route:

```text
start = (page - 1) * 20
count = 20
```

The returned JSON contains `list`, `page`, `pagecount`, `limit`, and `total`.
`pagecount` is calculated from the upstream `total`; if the service omits a
usable total, the implementation keeps the source behavior and returns
`Integer.MAX_VALUE` for both `pagecount` and `total`.

## Verification

The sidecar contract test uses an independent local HTTP fixture and verifies:

- all seven route branches;
- `sort`, `area`, `type`, `榜单`, and tag encoding;
- page 1/2/3/4 offsets;
- `items` versus `subject_collection_items` parsing;
- CatVod pagination metadata;
- category request timeout terminates the JVM sidecar.

The real probe was run with Windows x64, JDK 21, and the HTTPS Frodo endpoint:

```text
npm run spike:douban
```

All seven real routes returned successfully. Observed examples included:

- `hot_gaia`: 340 total, 20 items, 17 pages;
- `tv_hot`: 247 total, 20 items, 13 pages;
- `show_hot`: 71 total, 20 items, 4 pages;
- `movie`: 8 total;
- `tv`: 8 total;
- both ranking routes: 10 total.

The sidecar stopped cleanly after the requests. The existing generic JVM
probe still verifies an independent timeout kill and process isolation.

## Decision

`csp_Douban` remains a good JVM-native candidate for the implemented browse
surface. No Android Emulator/DEX runtime is needed for `homeContent` or
`categoryContent`; keep the DEX path optional for later spiders that depend on
unrecoverable Android-only behavior.

The next meaningful slice is `detailContent` (and then search), not a runtime
change.
