# Spike 8：JVM-native detailContent 垂直切片

## 范围

本 Spike 在现有 JVM-native `homeContent/categoryContent` 之后，增加选片到
详情的最小闭环。Android Emulator/DEX 不参与运行。

公开 JVM 合同：

```text
detailContent(List<String> ids) -> String
```

sidecar 使用已有 NDJSON RPC 方法名 `detail`，参数为：

```json
{"ids":["msearch:36246195"]}
```

## ID 规则与请求顺序

兼容现有列表产生的 `msearch:<id>`：

1. 去掉 `msearch:` 前缀；
2. 请求 `/api/v2/movie/<id>`；
3. 电影请求失败时，再请求 `/api/v2/tv/<id>`；
4. 两者都失败时，返回 `JVM_SPIDER_ERROR`，但不主动销毁 sidecar。

当前合同不改变列表中的 `vod_id`，详情结果仍返回原始的
`msearch:<id>`。

## 实现位置

| 层 | 变化 |
| --- | --- |
| JVM `Spider` | 增加默认 `detailContent(List<String>)` 合同 |
| `JvmSpiderHost` | 反射 `detailContent`，处理 `detail` RPC 和字符串数组 `ids` |
| `JvmSidecar` | 增加 `detailContent(ids, timeoutMs)` |
| `DoubanJvmSpider` | 调用 Frodo 详情接口并映射 CatVod 详情字段 |

详情返回形状：

```json
{
  "list": [{
    "vod_id": "msearch:36246195",
    "vod_name": "...",
    "vod_pic": "...",
    "vod_remarks": "评分：7.8",
    "vod_year": "2026",
    "vod_area": "美国,加拿大",
    "vod_class": "动作,科幻",
    "vod_director": "...",
    "vod_actor": "...",
    "vod_content": "...",
    "vod_pubdate": "2026-07-29(中国大陆)"
  }]
}
```

TV 详情额外映射 `episodes_count` 到 `vod_total`。

## 测试

本地 HTTP fixture 验证了：

- 电影详情映射；
- `msearch:<id>` 电影成功路径；
- 电影请求 404 后的 TV 回退路径；
- 多个 ID 的 `list` 返回；
- 上游 500 转成 RPC 错误且 sidecar 继续运行；
- 详情请求超时后终止 JVM sidecar，且进程不泄漏。

命令：

```text
npm test -- tests/douban-jvm.test.ts
```

## 真实验证

通过 JVM Jar、URLClassLoader、反射和 NDJSON sidecar 请求：

```text
npm run spike:douban-detail-sidecar
```

Windows x64 + JDK 21 实测通过：

- 电影 ID `36246195`：返回《蜘蛛侠：崭新之日》详情；
- TV ID `36721173`：返回《人鱼》详情及 `vod_total: 16`；
- 两条详情均包含标题、评分、封面、年份、地区、类型、导演、演员和简介；
- sidecar 请求结束后正常停止。

当前 Douban 服务对 TV ID 的 `/movie/<id>` 路径也可能返回可用详情，因此真实请求不一定触发 TV 回退；回退顺序已由本地 fixture 明确验证，代码仍保持 movie-first 规则。

## 判定

Spike 8 成功。桌面端现在具备 JVM-native 的选片到详情闭环；
`detail` RPC 的超时和进程隔离沿用现有 sidecar 机制。

下一步可以做 `searchContent` 的 JVM-native 扩展，但它不是原
`csp_Douban` DEX 自身提供的能力。
