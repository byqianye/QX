# G42 parse=1 受控解析链

## 状态

已完成。`playerContent` 返回 `parse=1` 时，桌面播放 seam 会创建一次类型化解析请求，按候选优先级执行受控解析，并把最终 `parse=0` 媒体地址交给现有 LocalProxy 和内嵌播放器。

## 合同

- `ParseRequest` 携带 source、flag、原始地址、候选列表、headers、超时和 playback session id。
- `ParserCandidate` 支持 `direct`、`json`、`redirect`、`html-declared`、`source-provided` 和本地 `fixture`。
- `ParseResult` 只返回 `parse=0`、最终媒体 URL、合并后的 headers、成功 parser、尝试记录和脱敏 diagnostics。
- 每次尝试记录 parser id、类型、结果、耗时和错误码；Cookie、Authorization、URL 和错误文本经过脱敏后才进入诊断。

## 解析与生命周期

候选按 `priority` 和 id 稳定排序。单个候选超时或失败会进入下一个候选；成功后停止后续尝试。嵌套 `parse=1` 结果受最大深度、最大尝试次数和 visited URL 集合约束，阻止自身循环与 A→B→A 循环。用户 AbortSignal 或 resolver 关闭会中止当前请求，并从 active request 集合移除。

## 安全边界

- 只允许 HTTP/HTTPS；`file:`、`data:`、`ftp:` 等协议被拒绝。
- 原始来源、明确配置的 allowed origins 和候选 endpoint origin 构成有限 allowlist；重定向后的 URL 会重新检查。
- 解析响应有 `content-length` 和流式读取上限，避免把解析器变成任意大响应代理。
- parser headers 只用于受控 fetch；最终带 headers 的媒体结果仍进入现有 LocalProxy，不向 renderer 暴露凭据。
- main 进程只从显式 JSON 环境变量读取候选，限制候选数量、字段长度和 header 数量；解析网页、任意网页嗅探留到 G44。

## UI 与错误

播放器状态携带 `resolving`、`attempting`、`failed`、`succeeded`、`cancelled` 和 `idle` 解析状态。用户看到简短状态；诊断展开项只展示 parser id、类型、结果和耗时。错误通过现有 AppError 映射，包含 `PARSE_UNAVAILABLE`、`PARSE_TIMEOUT`、`PARSE_CANCELLED`、`PARSE_CYCLE_DETECTED`、`PARSE_RESPONSE_TOO_LARGE`、`PARSE_ORIGIN_BLOCKED` 和 `PARSE_PROTOCOL_BLOCKED` 等代码。

## Fixture 与验证

`src/electron/media-fixture.ts` 提供本地 parser endpoint。`parse-one` 的 playerContent 返回 parse=1，fixture parser 返回本地 HLS URL；packaged E2E 在首次启动和重启轮次都检查最终媒体地址、parse=0、播放器无错误和资源清理。

专项测试覆盖 parse=0 直通、优先级回退、超时、JSON、headers、redirect、显式 HTML media 字段、source-provided、协议限制、origin 限制、响应大小、循环、最大深度、AbortSignal、resolver close、LocalProxy 接缝和 parse unavailable。

## 明确限制

本 Goal 不实现网页嗅探、任意页面 DOM 扫描、Rules/m3u8 变换、mpv、字幕或线路自动回退；这些能力分别留给后续 Gate。候选列表必须由应用配置显式提供，不宣称兼容所有第三方解析器。
