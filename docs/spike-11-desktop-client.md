# Spike 11：桌面端 Spider 调用层

## 目标

把 JVM sidecar 封装为桌面端可调用的统一 Spider 会话：

```text
init
homeContent
categoryContent
searchContent
detailContent
destroy
```

桌面端不再直接管理 `JvmSidecar.start()`、通用 `request()` 或子进程销毁细节。

## 公共 seam

新增 `DesktopSpiderClient`：

- 构造时用 `routeSpiderApi(api)` 校验引擎；Spike 11 只接受 `csp_*` JVM-native API；
- `init(ext)` 自动启动 sidecar 并发送 init RPC；
- 其他方法要求已初始化，原样返回 `SpiderResponse`；
- RPC `ok: false` 不被包装丢失；
- 请求超时沿用 `JvmSidecar` 的进程终止机制；
- `destroy()` 是唯一桌面端销毁入口；
- 会话销毁后不能重启，避免复用已关闭 JVM 进程。

## 本地验证

本地 fixture 通过 `DesktopSpiderClient` 覆盖了：

- `csp_Douban` 路由到 `DoubanJvmSpider`；
- `init/homeContent/categoryContent/searchContent/detailContent/destroy` 六个方法；
- 搜索返回的 `vod_id` 原样传入详情；
- 电影 `/movie/<id>` 优先、失败后 `/tv/<id>` 回退；
- `JVM_SPIDER_ERROR` 保持可观察；
- 搜索超时后 client 和 sidecar 都停止。
- 主搜索入口限 2 次尝试，遇到限流、429/403/5xx 后切换移动端 JSON 搜索入口；
- 备用入口仍返回 `msearch:<id>`，并保留 `total/pagecount/limit` 分页字段。

测试命令：

```text
npx vitest run tests/douban-jvm.test.ts
```

## 真实验证

```text
npm run spike:douban-desktop-client
```

探针通过 `DesktopSpiderClient` 执行真实 `searchContent("蜘蛛侠", false, 1)`，再将首条 `msearch:<id>` 传给 `detailContent`，检查详情字段和 sidecar 生命周期。

搜索入口现在采用有限恢复策略：

1. `movie.douban.com/subject_search` 最多请求 2 次，重试间隔 150ms；
2. 仍遇到限流或可恢复的上游状态时，切换
   `https://m.douban.com/rexxar/api/v2/search/subjects`；
3. 备用入口失败后才返回 `JVM_SPIDER_ERROR`，不会用本地 fixture 替代真实验证。

变更后的真实探针已通过：

```text
status: passed
search: total=199, pagecount=14, listCount=15
first vod_id: msearch:36246195
detail: movie/36246195 returned title, cover, rating, year, area, class, intro
sidecar: stopped=true
```

这证明桌面端 `csp_Douban` 的真实搜索→详情闭环已经通过。真实验证前后复核主入口仍返回 `error_info: 搜索访问太频繁。`，而探针获得了备用入口的 `total=199` 结果，因此本次闭环实际验证了备用搜索路径；详情仍按电影优先规则成功返回。

## 决策

桌面调用层闭环通过后，下一步再评估 `playerContent`。当前不启动 Android Emulator/DEX。
