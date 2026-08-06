# Spike 10：search → detail 端到端闭环

## 目标

验证 JVM-native Douban 搜索结果可以直接进入既有详情合同：

```text
searchContent(key, quick, page) -> CatVod list.vod_id
list.vod_id -> detailContent(ids)
```

本 Spike 不启动 Android Emulator/DEX。

## 端到端规则

- 搜索结果继续使用 `msearch:<id>`；
- 将搜索返回的 `vod_id` 原样传给 `detailContent`；
- 详情去掉 `msearch:` 后先请求 `/api/v2/movie/<id>`；
- 电影请求失败，再请求 `/api/v2/tv/<id>`；
- 详情结果必须保留原始 `msearch:<id>`，并包含标题、封面和简介等字段。

本地 HTTP fixture 已验证两条真实链路：

```text
e2e-movie -> msearch:movie-1 -> /movie/movie-1
e2e-tv    -> msearch:tv-1    -> /movie/tv-1 -> /tv/tv-1
```

## 真实验证

运行：

```text
npm run spike:douban-search-detail
```

默认执行：

1. `searchContent("蜘蛛侠", false, 1)`；
2. 取第一个 `msearch:<数字 ID>`；
3. 原样调用 `detailContent([vod_id])`；
4. 检查详情 ID、标题、封面、简介和 sidecar 停止状态。

真实探针使用 Windows x64 + JDK 21 的 JVM Jar、URLClassLoader、反射和 NDJSON sidecar；数字 ID 的解析保持为十进制字符串，不出现科学计数法。

本次真实运行结果：`passed`。关键词“蜘蛛侠”返回 `msearch:36246195`，第 1 页 15 条、总数 121；详情回传同一 ID，并包含标题、封面、评分、简介、年份、地区和类型；sidecar 最终停止。

## 异常与隔离

既有 JVM 测试继续覆盖：

- 详情 500 和错误 JSON 转为 `JVM_SPIDER_ERROR`，sidecar 仍可处理后续请求；
- 详情超时终止 sidecar；
- 搜索超时终止 sidecar；
- 所有测试 finally 销毁 sidecar。

Spike 10 新增测试还断言搜索请求之后的详情请求顺序，明确 movie-first 和 tv fallback。

## 决策

如果真实探针通过，`search → detail` 的 JVM-native 闭环成立，下一步优先接入桌面端调用层，再单独做 `playerContent`。只有播放或其他关键方法无法可靠移植时，才启动 Android Emulator/DEX Spike。

本 Spike 已通过，因此当前决策是：先接入桌面端调用层，暂不启动 Android Emulator/DEX，也暂不把 `playerContent` 混入本切片。
