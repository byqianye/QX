# Spike 9：JVM-native searchContent

## 目标

在现有 JVM-native `homeContent/categoryContent/detailContent` 和 NDJSON sidecar 上，验证并实现：

```text
searchContent(String key, boolean quick, int page) -> String
```

本 Spike 不启动 Android Emulator，也不把 DEX 当作 JVM class 加载。

## 接口验证结论

旧 Douban `/v2/movie/search` 文档和客户端实现仍可用于确认历史接口形状，但当前公开接口需要旧式 API 凭证，不能作为桌面端无凭证搜索入口。

实际探测结果：

- Frodo `/api/v2/search/subject` 和带 `search` 的 Frodo 候选路径返回 404；
- `api.douban.com/v2/movie/search` 返回凭证相关的 400；
- `https://movie.douban.com/subject_search?search_text=<key>&cat=1002&start=<start>` 返回 HTML；
- HTML 内有 `window.__DATA__` JSON，包含 `count`、`total`、`start`、`items`；
- `items` 的稳定字段为 `id`、`title`、`cover_url`、`rating`、`abstract`、`url`、`tpl_name`；
- `start=0`、`start=20`、`start=40` 可返回不同页，页面实际 `count` 为 15。

实现按返回的 `count=15` 固定分页步长；本地夹具和真实探针额外验证了 `start=0`、`start=15` 的第 1/2 页跳转。

因此本 Spike 采用公开网页搜索，不假设 DEX 自身存在可直接复用的 search API。

## JVM 合同与映射

`Spider` 增加默认 `searchContent` 合同，`JvmSpiderHost` 将它暴露为 NDJSON：

```json
{"method":"search","params":{"key":"蜘蛛侠","quick":false,"page":1}}
```

请求地址：

```text
https://movie.douban.com/subject_search
  ?search_text=<URL 编码关键词>&cat=1002&start=(page-1)*15
```

返回 CatVod 风格 JSON：

```json
{
  "list": [{
    "vod_id": "msearch:<id>",
    "vod_name": "...",
    "vod_pic": "...",
    "vod_remarks": "评分：8.2",
    "vod_content": "..."
  }],
  "page": 1,
  "pagecount": 9,
  "limit": 15,
  "total": 121
}
```

`quick` 暂时只为兼容 CatVod 合同保留；当前公开搜索入口没有第二个快速结果面。

## sidecar 与测试

本地 HTTP fixture 覆盖：

- 两页 `start=0/15` 和 `cat=1002`；
- `window.__DATA__` 解析及字段映射；
- 上游 500 转换为 `JVM_SPIDER_ERROR`，sidecar 继续可用；
- search 请求超时后终止 JVM sidecar；
- 既有 category/detail 超时隔离仍通过。

运行：

```text
npx vitest run tests/douban-jvm.test.ts
npm run spike:douban-search
```

真实探针默认关键词为 `蜘蛛侠`，可通过 `QX_DOUBAN_SEARCH_KEY` 覆盖。探针会请求第 1、2 页并确认两页有结果、分页元数据存在、首条 `msearch` ID 不同，最后销毁 sidecar。

## 依据

- [公开 Douban 搜索实现及字段映射](https://github.com/tamnd/douban-cli/blob/v0.3.0/douban/search.go)
- [历史 Douban API 搜索文档](https://www.cnblogs.com/softidea/p/8039351.html)
