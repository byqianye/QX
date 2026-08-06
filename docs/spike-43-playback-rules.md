# G43 Playback Rules 与 m3u8 安全处理

## 状态

已完成。`PlaybackRuleEngine` 是一个只作用于显式 proxy playback session 的纯规则层；它不拦截全局网络请求，也不改变 Spider 或 renderer 的任意 URL。

## 合同与作用域

`PlaybackRule` 包含 id、sourceId、enabled、priority、match、action、scope 和 safeDescription。规则按 priority/id 稳定排序，并且必须匹配当前 sourceId；可选的 playback session、origin、path、extension 和 line 条件进一步缩小作用范围。

支持的 action：

- URL rewrite、host replacement、path replacement；
- header merge、query parameter；
- m3u8 URI rewrite、line filter、显式 marker filter。

规则在 `PlaybackProxyServer.createSession` 时处理源 URL/headers，在 playlist 响应进入 LocalProxy 播放器前处理清单。Key、Map、子清单、segment URI、DISCONTINUITY 与未命中的 tag 保持原顺序；相对 URI 以当前清单 URL 解析。

## 空清单与错误

处理后没有任何媒体节点时抛出 `PLAYBACK_RULE_INVALID`，Proxy 返回 422，不把空清单交给播放器。规则产生的非法协议、URL credential、host 或 port 同样拒绝。规则冲突不静默覆盖：结果保留优先级顺序，并在 dry run warnings 中报告冲突。

## Dry Run

`dryRunSource` 与 `dryRunPlaylist` 返回原地址、修改后地址、命中规则 id、删除/保留节点数、warnings 和脱敏差异。URL query 只显示 `[redacted]`，不输出 token、Cookie、Authorization 或完整媒体 query。

## Fixture 与验证

Electron media fixture 的 protected HLS 包含显式 `#EXT-X-CUE-OUT` marker。packaged E2E 为 inline playback source 安装 path-scoped marker filter；首启和重启轮次都通过 Proxy 获取 protected playlist，并确认 marker 已删除，同时 parse chain、headers、LocalProxy、线路与播放器检查继续通过。

专项测试覆盖 URL/query/path/host/header、规则优先级和冲突、相对 URI、Key、Map、segment、marker、空清单保护、dry run、source 隔离和 session 边界。没有接入未授权影视源，也没有把规则层扩大成开放代理。

## 明确限制

G43 只处理已有受控播放响应，不实现网页 DOM 嗅探、mpv、字幕、线路自动回退或服务端转码。网页嗅探留到 G44。
