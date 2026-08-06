# G30—G41 多引擎基础与来源管理归档

## 状态

已完成并在恢复阶段建立 checkpoint。本文档记录 G30—G41 的实现边界、验证范围和明确限制；不扩展到 G42—G49 的播放增强。

## 目标与依赖

G30—G41 建立统一 MediaSource 合同、JVM/QuickJS/Python 正式引擎、Engine Router、内容哈希信任、配置历史与刷新审查、站点管理、多站点 session、聚合搜索以及健康/熔断能力。

依赖 G21—G29 已完成的 Spider、LocalProxy、播放 Session、状态持久化和诊断脱敏基础。

## 实现范围

- `src/source/`：统一 source contract、capabilities、normalizer 以及 JVM/QuickJS/Python/Jellyfin 适配。
- `src/spider/`：JVM sidecar、QuickJS worker、Python NDJSON sidecar、artifact/runtime 错误和 desktop client seam。
- `src/engine/`：Engine Router 与带去重、引用计数、并发上限和关闭清理的 Source Session Registry。
- `src/config/`：内容哈希信任、版本历史、缓存、差异和刷新审查。
- `src/desktop/`：来源路由、站点管理、导入/刷新/聚合搜索 UI server seam。
- `src/search/`、`src/health/`：并发聚合搜索、取消、超时隔离、去重、健康指标、熔断和恢复。
- `src/jellyfin/`：Jellyfin 专用客户端与播放 seam；凭据不进入通用 source 结果。

## 安全和运行时边界

- JVM-native Spider 与 Android DEX 严格区分；DEX 只做明确不支持返回，不宣称通用兼容。
- QuickJS 通过受控宿主请求，不暴露 Node、文件系统或任意进程能力。
- Python 使用外部 Python runtime 和 disposable sidecar workspace，不提前随包分发 Python。
- 信任记录绑定 Spider 实际内容 fingerprint；source-only legacy trust 不能绕过内容绑定执行确认。
- 配置响应未修改时仍会重新检查已声明 Spider 的内容 hash；内容变化进入危险变更待审查，不会静默替换当前配置。
- 诊断、健康摘要和 UI 状态使用现有脱敏合同，不保存 token、Cookie、Authorization、私有媒体地址或密码。
- 解析链、Rules、隔离网页嗅探、mpv、字幕和线路自动回退均留到 G42—G49。

## 验收映射

| Goal | 验证入口 |
| --- | --- |
| G30 | `tests/source-contract.test.ts`、`tests/site-management.test.ts` |
| G31 | `tests/jvm-engine.test.ts`、JVM fixture、`tests/douban-jvm.test.ts` |
| G32 | `tests/quickjs-engine.test.ts` |
| G33 | `tests/python-engine.test.ts` |
| G34 | `tests/engine-router.test.ts` |
| G35 | `tests/trust.test.ts`、`tests/spider-import.test.ts` |
| G36 | `tests/config-history.test.ts`、`tests/config-refresh.test.ts` |
| G37 | `tests/site-management.test.ts`、`tests/spider-import.test.ts` |
| G38 | `tests/spider-import.test.ts`、`tests/engine-router.test.ts` |
| G39 | `tests/aggregate-search.test.ts`、`tests/source-health.test.ts` |
| G40 | `tests/config-refresh.test.ts` |
| G41 | `tests/source-health.test.ts` |

## 已修复的恢复审计问题

恢复审计期间新增了两个回归测试并修复：

1. Session Registry 的 active-session 限制此前只计算已登记 entry，并发创建会暂时超限；现在 pending creation 也占用 slot。
2. source-only legacy trust 此前可能使用通配 fingerprint；现在旧记录只能作为历史可读状态，不能绕过实际内容 fingerprint 检查。

## 明确限制

- 缺少系统 JRE、Python 或真实 mpv 时，只能验证稳定的缺失能力错误或合同测试；不伪造运行时可用。
- Jellyfin 的通用 source contract 与专用播放 proxy 是两个边界，token 不通过通用 media result 暴露。
- G30—G41 不包含 parse=1 解析链和网页嗅探，因此不对第三方解析器或任意网页兼容性作声明。
