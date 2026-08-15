# QX 影视后端接口文档

状态：与当前 `src-tauri` 和 `renderer` 代码同步的 v1 接口说明。

## 1. 接口定位

本项目当前的“后端接口”是 Tauri desktop IPC/RPC，不是对外监听的 HTTP REST API。

- 调用方：Tauri WebView 中的 renderer。
- 传输方式：`@tauri-apps/api/core` 的 `invoke`。
- 命令版本：`qx.backend.v1`。
- 事件版本：`qx.event.v1`（当前文档只覆盖请求/响应命令）。
- 所有命令的参数名都是 `{ request }`。
- 所有请求都必须经过统一包络；不能直接把业务 payload 作为 `invoke` 参数。

相关实现：

- [统一数据结构](../renderer/src/contracts.ts)
- [renderer RPC 封装](../renderer/src/tauri-rpc.ts)
- [Rust 命令注册与错误映射](../src-tauri/src/lib.rs)
- [Tauri 契约测试](../tests/tauri-contract.test.ts)

## 2. 通用请求与响应

### 2.1 请求包络

字段采用 camelCase：

```json
{
  "version": "qx.backend.v1",
  "requestId": "req-uuid",
  "sessionId": "renderer-session-uuid",
  "sequence": 1,
  "payload": {}
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | `"qx.backend.v1"` | 是 | RPC 协议版本；不匹配返回 `RPC_VERSION_UNSUPPORTED`。 |
| `requestId` | string | 是 | 单次请求唯一 ID；响应原样带回。 |
| `sessionId` | string | 是 | renderer 或业务会话 ID；部分业务 payload 还会有自己的资源会话 ID。 |
| `sequence` | number | 是 | 调用序号；响应原样带回。 |
| `payload` | object | 是 | 具体命令的 payload。 |

### 2.2 成功响应

```json
{
  "version": "qx.backend.v1",
  "requestId": "req-uuid",
  "sessionId": "renderer-session-uuid",
  "sequence": 1,
  "ok": true,
  "payload": {}
}
```

### 2.3 失败响应

```json
{
  "version": "qx.backend.v1",
  "requestId": "req-uuid",
  "sessionId": "renderer-session-uuid",
  "sequence": 1,
  "ok": false,
  "error": {
    "category": "InvalidConfig",
    "reasonCode": "RPC_VERSION_UNSUPPORTED",
    "retryable": false,
    "diagnosticId": "rpc-invalid-version",
    "safeDetails": {}
  }
}
```

`safeDetails` 只允许安全诊断信息。播放请求中的 Cookie、Authorization、临时 URL 和进程句柄不得放入响应。

错误分类固定为：

| category | 含义 |
| --- | --- |
| `InvalidConfig` | payload、配置、存储或动作参数无效。 |
| `UnsupportedRuntime` | 当前运行时不支持该源或能力。 |
| `SourceUnavailable` | 源不可用、会话不存在、代理目标不可用。 |
| `ComponentMissing` | 可选组件未安装或组件存储不可用。 |
| `ComponentUntrusted` | 组件签名或信任锚不通过。 |
| `UnsupportedDrm` | 播放 DRM 能力不支持。 |
| `PlaybackFailed` | 播放、窗口、代理或底层请求失败。 |

## 3. 命令总览

| Tauri command | 请求 payload | 成功 payload | 主要用途 |
| --- | --- | --- | --- |
| `backend_app_snapshot` | `{}` | `AppSnapshot` | 查询后端版本、数据目录和数据库路径。 |
| `backend_config_catalog` | `ConfigCatalogPayload` | `ConfigCatalogSnapshot` | 导入/解析源配置，可选远程拉取。 |
| `backend_source_session` | `SourceSessionPayload` | `SourceSessionResult` | 打开、调用、取消、关闭影视源会话。 |
| `backend_playback_sources` | `PlaybackSourceResolvePayload` | 播放源解析结果 | 跨源搜索并生成候选播放源。 |
| `backend_runtime_capability` | `RuntimeCapabilityPayload` | `RuntimeCapabilitySnapshot` | 探测 native/QuickJS/资源能力。 |
| `backend_quickjs_sidecar` | `QuickJsSidecarPayload` | sidecar JSON payload | 管理 QuickJS sidecar 会话。 |
| `backend_playback_proxy` | `PlaybackProxyPayload` | `PlaybackProxySnapshot` | 创建或关闭本地播放代理。 |
| `backend_webview_sniffer` | `WebviewSnifferPayload` | `WebviewSnifferResult` | Windows WebView2 播放页探测。 |
| `backend_mpv` | `MpvPayload` | `MpvSnapshot` | 管理已验证的 mpv 组件会话。 |
| `backend_live` | `LivePayload` | `LiveSnapshot` | 直播源、频道、智能频道和故障切换。 |
| `backend_epg` | `EpgPayload` | `EpgSnapshot` | XMLTV EPG 源、映射和时间线。 |
| `backend_desktop_services` | `DesktopServicePayload` | `DesktopServiceSnapshot` | 缓存、备份、本地媒体、弹幕和下载。 |
| `backend_player_window` | `PlayerWindowPayload` | `PlayerWindowSnapshot` | 独立播放器窗口生命周期。 |
| `backend_business_data` | `BusinessDataPayload` | `BusinessDataSnapshot` | 通用 SQLite 业务记录。 |
| `backend_business_features` | `BusinessFeaturePayload` | `BusinessFeatureSnapshot` | 历史、收藏和追剧功能。 |
| `backend_component_manager` | `ComponentManagerPayload` | `ComponentManagerSnapshot` | 可选组件签名验证、安装、回滚、卸载。 |

## 4. 接口详细说明

### 4.1 `backend_app_snapshot`

请求 payload 必须是空对象 `{}`。

成功 payload：

```json
{
  "appName": "QX褰辫",
  "backend": "tauri",
  "rpcVersion": "qx.backend.v1",
  "dataDirectory": "C:/Users/<user>/AppData/Local/...",
  "databasePath": "C:/Users/<user>/AppData/Local/.../qx-v1.sqlite3"
}
```

该命令会创建应用数据目录并打开 SQLite 数据库。路径来自 Tauri app-local-data；仅在 `QX_TAURI_E2E=1` 时允许使用 `QX_TAURI_E2E_DATA_ROOT` 覆盖测试目录。

### 4.2 `backend_config_catalog`

请求：

```json
{
  "source": "inline:tauri",
  "sourceKind": "json",
  "raw": "{\"sites\":[]}",
  "fetchRemote": false,
  "timeoutMs": 10000
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | 配置来源标识；远程配置通常是 URL。 |
| `sourceKind` | `url \| file \| json \| multi` | 配置来源类型。 |
| `raw` | string | 内联 JSON、文件内容或已获取文本。远程 URL 可为空。 |
| `fetchRemote` | boolean | 为 true 时从 `source` 远程获取。默认 false。 |
| `timeoutMs` | number | 可选请求超时。 |

成功 payload：

```json
{
  "schemaVersion": "v1",
  "source": "inline:tauri",
  "sourceKind": "json",
  "versionHash": "sha256-or-content-hash",
  "siteCount": 1,
  "usedCache": false,
  "validVersionCount": 1,
  "warningCode": null,
  "sites": [
    {
      "key": "cms",
      "name": "CMS",
      "api": "https://example.test/api.php",
      "siteType": 1,
      "ext": null
    }
  ]
}
```

`warningCode` 目前可能为 `CONFIG_HTTP_UNAUTHENTICATED`，表示远程配置走 HTTP 且没有认证，不等于配置已被信任。renderer 会先展示站点摘要，再由用户确认。

`backend_config_catalog` also accepts two Rust-only maintenance actions. They do not change the existing ingest payload contract:

```json
{"action":"history","source":"inline:tauri"}
```

This returns `{ "schemaVersion": "v1", "source": "...", "activeVersionHash": "...", "versions": [] }`.

To activate a previously stored version, send:

```json
{"action":"activate","source":"inline:tauri","versionHash":"<sha256>"}
```

The response is the normal `ConfigCatalogSnapshot`. A later invalid/remote-failed ingest falls back to the activated version. Unknown versions fail with `CONFIG_VERSION_NOT_FOUND`; no version is deleted.

Tauri 渲染器对应的业务入口是：

| 路径 | 请求 | 返回 | 说明 |
| --- | --- | --- | --- |
| `/api/import/history` | `{}` | `RendererEnvelope.configHistory` | 查询当前已导入源的版本历史；必须先完成一次配置导入。 |
| `/api/import/activate` | `{"versionHash":"<sha256>"}` | `RendererEnvelope.import` + `RendererEnvelope.configHistory` | 激活指定版本；旧会话会关闭，页面回到“确认使用此来源”，不会自动恢复信任或发起播放请求。 |

这两个入口只调用 Rust 的 `backend_config_catalog`，没有新增 HTTP 或 Electron 回退路径。

### 4.3 `backend_source_session`

请求结构：

```json
{
  "action": "open",
  "sessionId": "source-session-1",
  "sourceId": "config-1",
  "siteKey": "cms",
  "api": "https://example.test/api.php",
  "siteType": 1,
  "ext": "",
  "method": "home",
  "params": {"page": 1},
  "timeoutMs": 15000,
  "headers": {"Referer": "https://example.test/"}
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `open \| call \| cancel \| close \| snapshot` | 会话动作。 |
| `sessionId` | string | 资源会话 ID。所有动作必须带上。 |
| `sourceId` | string | `open` 时的配置/源 ID。 |
| `siteKey` | string | `open` 时的站点 key。 |
| `api` | string | `open` 时的 HTTP(S) API；不允许 URL 内嵌用户名或密码。native 源使用其 API 标识。 |
| `siteType` | 0/1/3/4 | 站点类型。 |
| `ext` | string | 源扩展配置。 |
| `method` | string | `init`、`home`、`homeVideo`、`category`、`search`、`detail`、`player`、`playback`。 |
| `params` | object | 传给源方法的业务参数。 |
| `timeoutMs` | number | 会话请求超时。 |
| `headers` | object | 额外请求头；禁止 Host、Connection、Content-Length 等受保护头。 |

成功 payload：

```json
{
  "session": {
    "sessionId": "source-session-1",
    "sourceId": "config-1",
    "siteKey": "cms",
    "api": "https://example.test/api.php",
    "siteType": 1,
    "state": "ready",
    "availabilityReason": null,
    "capabilities": {
      "home": true,
      "category": true,
      "search": true,
      "detail": true,
      "playback": true,
      "localProxy": false,
      "filters": true,
      "pagination": true,
      "engine": "http"
    }
  },
  "method": "home",
  "result": {"list": []},
  "cancelled": false
}
```

生命周期：`open` → 一个或多个 `call` → `cancel` 或 `close`。`snapshot` 只读取状态。标准 HTTP 源由 Rust 发起请求；native 源由 `native_sources` 分发；QuickJS 源不应通过此命令调用，而应使用 QuickJS 接口。

### 4.4 `backend_playback_sources`

请求：

```json
{
  "query": "电影名",
  "currentSiteKey": "cms",
  "currentVod": {"vod_id": "movie-1", "vod_name": "电影名"},
  "currentCatalog": null,
  "sourceId": "config-1",
  "sessionId": "source-session-1",
  "sites": [
    {"key": "cms", "name": "CMS", "api": "https://example.test/api.php", "siteType": 1}
  ]
}
```

服务会限制站点数最多 128 个，并跳过 QuickJS 隔离会话以外的跨源 QuickJS 调用。返回值包含 `query`、`searchedSites`、`successfulSites`、`failedSites`、`candidates` 和 `diagnostics`；候选通常包含站点、标准化后的 `vod`、播放线路、评分、是否可播放等字段。

### 4.5a `backend_playback_fallback`

该命令承载 Tauri 播放链路的回退策略状态，不由 renderer 维护协调器实例。`sessionId` 是播放业务会话 ID；同一回退流程的所有动作必须复用它。

请求 payload：

```json
{
  "action": "begin",
  "sessionId": "playback-session-1",
  "mode": "prompt",
  "maxAttempts": 3,
  "totalTimeoutMs": 45000,
  "candidates": [
    {
      "id": "alternate:movie-1",
      "label": "Alternate - Movie",
      "kind": "same-content",
      "sourceId": "alternate",
      "lineKey": "0"
    }
  ]
}
```

`action` 支持：

| action | 作用 | 关键字段 |
| --- | --- | --- |
| `begin` | 创建或重置回退流程，并对候选去重、排序和限额 | `candidates`、`mode`、`maxAttempts`、`totalTimeoutMs` |
| `snapshot` | 读取当前状态 | 无 |
| `set-mode` | 设置 `off`、`prompt` 或 `auto` | `mode` |
| `trigger` | 报告播放失败并返回 `none`、`prompt`、`attempt` 或 `stopped` 决策 | `trigger`、`reason` |
| `approve` | 批准当前 `prompt` 的下一候选 | 无 |
| `finish` | 结束当前尝试 | `success` |
| `cancel` / `stop` | 取消或停止回退 | 可选 `reason` |
| `clear` | 清理该播放会话的后端状态 | 无 |

成功 payload：

```json
{
  "state": {
    "mode": "prompt",
    "status": "prompt",
    "trigger": "player-fatal",
    "reason": "HLS_SEGMENT_FAILED",
    "current": null,
    "next": { "id": "alternate:movie-1", "label": "Alternate - Movie", "kind": "same-content" },
    "attempts": 0,
    "maxAttempts": 3,
    "tried": [],
    "startedAt": 1700000000000,
    "deadlineAt": 1700000045000
  },
  "decision": { "kind": "prompt", "candidate": { "id": "alternate:movie-1", "label": "Alternate - Movie", "kind": "same-content" } }
}
```

`user-pause`、`seek`、`single-buffer` 和 `short-fluctuation` 只返回忽略决策，不会推进回退。状态机会强制最大尝试次数和总超时；候选标签、ID 和原因会做长度及敏感路径清理。该接口只负责策略状态，不负责解析、WebView2 sniff、LocalProxy 或 mpv 的实际启动。

### 4.5 `backend_runtime_capability`

请求字段：`api` 必填；`ext`、`scriptBytes`、`allowedOrigins`、`artifactName`、`artifactBase64` 可选。

成功 payload：

```json
{
  "runtime": "native",
  "supported": true,
  "reasonCode": "native_jianpian_supported",
  "capabilities": {"home": true, "category": true, "search": true, "detail": true, "player": true},
  "assetClassification": null
}
```

该接口是能力探测，不是能力安装。`supported: false` 时必须按 `reasonCode` 降级或提示；不能据此宣称已经具备完整 DEX、Jianpian 或播放器链路。

### 4.6 `backend_quickjs_sidecar`

请求字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `load \| capabilities \| call \| close` | sidecar 动作。 |
| `sessionId` | string | QuickJS 会话 ID。 |
| `script` | string | `load` 必填；可为内联脚本或允许来源中的 URL。 |
| `moduleSources` | object<string,string> | 可选模块源码映射。 |
| `allowedOrigins` | string[] | 脚本网络访问允许的来源。 |
| `name` | string | `call` 必填的方法名。 |
| `args` | unknown[] | `call` 的参数。 |

典型调用顺序：

```text
runtime_capability(api=js:...) -> load -> capabilities -> call(init/home/detail/player) -> close
```

sidecar 的结果是原样 JSON payload，具体方法由脚本导出能力决定。sidecar 不可启动、会话不存在或脚本失败时分别映射为 `QUICKJS_SIDECAR_UNAVAILABLE` 或 sidecar 返回的错误码。该接口不等于已经完成完整 QuickJS 兼容性；实际能力取决于随应用提供且可启动的 sidecar 和脚本 API。

### 4.7 `backend_playback_proxy`

请求：

```json
{
  "action": "start",
  "sessionId": "playback-1",
  "url": "https://media.example.test/video.m3u8",
  "headers": {"Referer": "https://source.example.test/"}
}
```

`action` 只有 `start` 和 `close`。`start` 返回：

```json
{
  "sessionId": "playback-1",
  "proxyUrl": "http://127.0.0.1:43123/__qx_playback/token",
  "mediaType": "hls",
  "state": "ready",
  "reasonCode": null
}
```

支持的 `mediaType` 为 `hls`、`dash`、`progressive`。代理只接受安全的 HTTP(S) 目标和请求头，拒绝本机/私有地址、受保护头及不安全重定向；关闭时使用同一个 `sessionId`。`PLAYBACK_PROXY_NOT_FOUND` 表示会话已不存在。

### 4.8 `backend_webview_sniffer`

`action` 为 `sniff`、`cancel` 或 `snapshot`。

`sniff` 常用字段：`sessionId`、`sourceId`、`playbackSessionId`、`initialUrl`、`headers`、`allowedOrigins`、`maxRedirects`、`maxPages`、`maxResources`、`maxTotalMs`、`maxIdleMs`。

成功 payload：

```json
{
  "schemaVersion": "qx.webview-sniffer.v1",
  "sessionId": "sniff-1",
  "state": "found",
  "media": {"parse": 0, "url": "https://media.example.test/video.m3u8", "headers": {}},
  "candidateCount": 1,
  "rejectedCount": 0,
  "dataDirectoryRemoved": true,
  "platform": "windows"
}
```

状态包括 `found`、`running`、`idle`、`cancelling`。错误码包括 `WEBVIEW_SNIFFER_INVALID`、`WEBVIEW_SNIFFER_UNSUPPORTED`、`WEBVIEW_SNIFFER_WINDOW_FAILED`、`WEBVIEW_SNIFFER_FAILED`、`WEBVIEW_SNIFFER_CANCELLED`、`WEBVIEW_SNIFFER_TIMEOUT`。该接口在非 Windows 环境可能返回 unsupported。

### 4.9 `backend_mpv`

| action | 必填字段 | 行为 |
| --- | --- | --- |
| `start` | `sessionId`、`source` | 启动已验证的 mpv 组件并加载 source。 |
| `command` | `sessionId`、`command` | 向当前会话发送受校验的 mpv IPC 命令。 |
| `close` | `sessionId` | 关闭 mpv 会话。 |

成功 payload 为 `{ sessionId, state: "ready" | "closed", reasonCode? }`。组件不存在返回 `MPV_COMPONENT_MISSING`；命令或进程失败返回 `MPV_REQUEST_FAILED`。mpv 不随核心 NSIS 资源自动打包，必须先经过组件管理器验证/安装。

### 4.10 `backend_business_data`

请求字段：

```json
{
  "action": "upsert",
  "entity": "view_state",
  "id": "renderer",
  "sourceId": "source-1",
  "value": {"theme": "dark"}
}
```

`action`：`read`、`upsert`、`backup`、`remove`、`list`、`restore`。

- `read`：按 `entity + id` 读取。
- `upsert`：写入一条业务记录。
- `list`：列出指定 `entity`。
- `remove`：删除指定记录。
- `backup`：导出数据库业务数据。
- `restore`：从 `value` 恢复备份数据。

成功 payload：`{ schemaVersion: "v1", entity, id, found, value?, recordCount }`。数据库位置由 `backend_app_snapshot` 返回的 `databasePath` 决定。不要把 Cookie、Authorization、token 或临时播放 URL 写入业务记录。

### 4.11 `backend_business_features`

请求结构：`{ action, feature, id?, sourceId?, value }`。

支持的 feature/action：

| feature | action |
| --- | --- |
| `history` | `snapshot`、`upsert`、`delete`、`delete-progress`、`clear`、`pause` |
| `favorites` | `snapshot`、`toggle`、`delete`、`move`、`reorder`、`group-create`、`group-rename`、`group-delete`、`group-reorder` |
| `follow` | `snapshot`、`upsert`、`delete`、`mark-watched`、`mark-unwatched` |

成功 payload：`{ schemaVersion: "v1", feature, state }`。不支持的组合返回 `BUSINESS_FEATURE_INVALID`。

### 4.12 `backend_live`

请求结构：`{ action, id?, value }`。已实现动作：

`snapshot`、`refresh`、`preview`、`apply`、`toggle`、`remove`、`clear-preview`、`play`、`line`、`stop`、`sync`、`smart-create`、`smart-update`、`smart-delete`、`smart-member-add`、`smart-member-remove`、`smart-member-update`、`smart-member-priority`、`smart-member-enable`、`smart-member-reorder`、`smart-select`、`smart-play`、`smart-epg`、`smart-member-health`、`failover-mode`、`failover-approve`、`failover-cancel`、`failover-stay`、`failover-return`。

常见 value 字段：

- `preview`：`type`、`name`，以及 `location`/`fileName`、`content` 等来源数据。
- `apply`：`id` 为 preview ID。
- `toggle`：`sourceId`、`enabled`。
- `play`：频道、流或智能频道选择字段。
- `line`：频道当前线路字段。
- `sync`：播放器状态、时间、错误事件。
- `failover-mode`：`mode` 为 `off`、`prompt` 或 `auto`。

成功 payload 为 `{ schemaVersion: "v1", state }`，其中 `state.live` 包含源、频道、会话、播放器、EPG、智能频道和 failover 状态。

### 4.13 `backend_epg`

请求结构：`{ action, id?, value }`。已实现动作：

`snapshot`、`refresh`、`preview`、`apply`、`toggle`、`remove`、`clear-preview`、`mapping-set`、`mapping-confirm`、`mapping-clear`、`mapping-confirm-high`、`alias-set`、`alias-remove`、`timeline`、`timeline-clear`。

`preview` 通常需要 `value.type`、`value.name`，并提供 `content`、`location` 或 `fileName`；`apply` 使用 `id` 指向 preview；映射动作使用 `liveChannelId`、`epgSourceId`、`epgChannelId` 等字段；`timeline` 使用 `liveChannelId`。

成功 payload 为 `{ schemaVersion: "v1", state }`。解析 XMLTV 失败返回 `EPG_INVALID`，源请求失败返回 `EPG_SOURCE_REQUEST_FAILED`。

### 4.14 `backend_cast`

The Rust DLNA boundary accepts `{ action, value }` with these actions: `snapshot`, `discover`, `play`, `pause`, `resume`, `stop`, `seek`, `position`, `transport`, and `disconnect`.

`discover` performs local-network SSDP discovery and returns `state.cast.devices`. `play` requires `value.deviceId`, `value.url`, and an optional `value.title`; it performs AVTransport `SetAVTransportURI` followed by `Play`. `pause` and `resume` send AVTransport `Pause` and `Play`. `stop` sends `Stop`, `seek` requires a finite non-negative `value.position` in seconds and sends `Seek` with `REL_TIME`, `position` sends `GetPositionInfo`, and `transport` sends `GetTransportInfo`. Query actions update the session position/state when the device returns those fields. `disconnect` clears the local session.

Only HTTP(S) media without credentials is accepted. Sources requiring request headers or the legacy media bridge return `DLNA_MEDIA_HEADERS_UNSUPPORTED` instead of being silently sent without headers. Devices that do not advertise a requested AVTransport action return `DLNA_UNSUPPORTED`.

### 4.15 `backend_push`

The Rust Push boundary accepts `{ action, value }` with these actions: `snapshot`, `refresh`, `settings`, `submit`, `confirm`, `reject`, `cancel`, and `clear`.

`snapshot` and `refresh` start a loopback-only listener on `127.0.0.1` and return `state.push.endpoint`. The listener accepts `POST /push` with either `{ "url": "https://media.example.test/video.mp4", "title": "Fixture" }` or `{ "uri": "push://url?url=...&title=..." }`. Only credential-free HTTP(S) URLs are accepted; source-item, local-file, live-channel, fixture, file URLs, and custom request headers are not silently downgraded.

The default policy is confirmation-required. `POST /push` returns a preview with HTTP 202, and the renderer confirms it through `action: "confirm"` with `{ "id": "push-...", "decision": "play" }`, or rejects it through `action: "reject"`. `cancel` removes a pending or queued request; `clear` removes recent records. `settings` accepts `enabled`, `port`, `confirmationPolicy` (`ask` or `allow-trusted-local`), and `conflictMode` (`replace`, `queue`, or `reject`). LAN control remains disabled and the listener is intentionally bound to loopback.

An accepted result contains `state.result.playback` with `{ sessionId, url, title }`. The renderer then starts the existing Tauri playback proxy before exposing the source to the player. This slice supports URL Push only; it does not claim native resolution of source-item or local-file Push references.

### 4.16 `backend_desktop_services`

请求结构：`{ action, value }`。该命令返回统一的 `DesktopServiceSnapshot`，实际 `state` 为组合对象。

| 功能 | action |
| --- | --- |
| 缓存/存储 | `cache-snapshot`、`cache-refresh`、`cache-clear`、`storage-refresh`、`storage-open`、`storage-switch` |
| 备份 | `backup-create`、`backup-pick`、`backup-apply`、`backup-clear`、`backup-open` |
| 弹幕 | `danmaku-snapshot`、`danmaku-load`、`danmaku-settings`、`danmaku-clear`、`danmaku-sync` |
| 播放降级 | `player-fallback-snapshot`、`player-fallback-mode`、`player-fallback-approve`、`player-fallback-cancel`、`player-sync` |
| 本地媒体 | `local-snapshot`、`local-rescan`、`local-cancel-scan`、`local-active`、`local-remove-folder`、`local-remove-item`、`local-locate`、`local-open-file`、`local-add-folder`、`local-drop`、`local-play` |
| 下载 | `download-snapshot`、`download-refresh`、`download-select-folder`、`download-add`、`download-pause`、`download-resume`、`download-cancel`、`download-retry`、`download-remove`、`download-open-folder` |

常用 value 字段：`cache-clear` 使用 `scope=expired|images|search|all`；`player-fallback-mode` 使用 `mode=off|prompt|auto`；本地媒体使用 `paths`、`rootId`、`itemId`；下载使用 `path`、`title`、`url`、`targetDirectoryId`。路径必须由用户选择或已存在并能被后端规范化，不能用接口绕过路径校验。

### 4.17 `backend_player_window`

请求为 `{ action, value }`，动作：`open`、`snapshot`、`sync`、`attach`、`stop`、`close`。

- `open`：`value.player` 必填，可选 `value.session`；创建/复用名为 `player` 的 Tauri WebView 窗口。
- `sync`：同步 `status`、`currentTime`、`duration`、`volume`、`muted`、`error`。
- `attach`：关闭/附着流程中的窗口状态处理。
- `stop`/`close`：清理播放器状态并关闭窗口。
- `snapshot`：读取当前窗口状态。

成功 payload：`{ schemaVersion: "v1", state }`。

### 4.18 `backend_component_manager`

请求字段：`action`、`componentId`、`manifestJson`、`signatureBase64`、`publicKeyBase64`、`artifactBase64`、`running`。

动作：`verify`、`install`、`rollback`、`uninstall`。

manifest 结构：

```json
{
  "version": 1,
  "components": [
    {
      "id": "mpv",
      "version": "1",
      "target": "x86_64-pc-windows-msvc",
      "sha256": "...",
      "url": "https://example.test/mpv.zip",
      "payloadPath": "mpv.exe"
    }
  ]
}
```

验证要求 detached Ed25519 签名、公钥、manifest 和 artifact hash 均通过；release 构建必须配置编译期信任锚。成功状态为 `verified`、`active`、`rolled_back` 或 `uninstalled`。失败主要为 `COMPONENT_MANIFEST_INVALID`、`COMPONENT_UNTRUSTED`、`COMPONENT_STORAGE_FAILED`。

## 5. JavaScript 调用示例

renderer 应使用项目已有封装：

```ts
import { requestSourceSession } from "./tauri-rpc.js";

const result = await requestSourceSession({
  action: "open",
  sessionId: crypto.randomUUID(),
  sourceId: "config-1",
  siteKey: "cms",
  api: "https://example.test/api.php",
  siteType: 1,
});
```

直接调用 Tauri 时，参数必须嵌套在 `request` 中：

```ts
import { invoke } from "@tauri-apps/api/core";

const request = {
  version: "qx.backend.v1",
  requestId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  sequence: 1,
  payload: {},
};

const response = await invoke("backend_app_snapshot", { request });
```

不要在浏览器普通网页环境调用这些命令；`tauri-rpc.ts` 会先检查 `__TAURI_INTERNALS__`。

## 6. 错误处理建议

1. 先检查 Tauri 调用是否抛出，再检查返回值是否为 `ok: false`。
2. `retryable: true` 才允许有限重试；`InvalidConfig`、签名不可信和不支持能力不要盲目重试。
3. `requestId`、`sessionId`、`sequence` 必须写入诊断日志，业务敏感字段不要写日志。
4. 收到 `RPC_VERSION_UNSUPPORTED` 时停止调用并升级 renderer/backend 合约，不要猜测字段。
5. 播放失败时先关闭当前 proxy/mpv/WebView 会话，再按业务层 failover 状态决定是否切换线路。

常见 reason code：

| reasonCode | 处理建议 |
| --- | --- |
| `RPC_VERSION_UNSUPPORTED` | renderer 与 Rust 版本不一致，不能重试。 |
| `CONFIG_PAYLOAD_INVALID` | 检查 `source/sourceKind/raw`。 |
| `SOURCE_SESSION_NOT_FOUND` | 重新 `open`，不要复用已关闭会话。 |
| `SOURCE_SESSION_REQUEST_FAILED` | 检查源、超时和网络；可按 retryable 处理。 |
| `QUICKJS_SIDECAR_UNAVAILABLE` | 检查 sidecar 是否随发布物提供并可启动。 |
| `PLAYBACK_PROXY_INVALID` | 检查目标 URL、重定向和请求头。 |
| `WEBVIEW_SNIFFER_TIMEOUT` | 结束本次探测，提示用户或走备用播放链路。 |
| `MPV_COMPONENT_MISSING` | 先验证/安装 mpv 组件。 |
| `COMPONENT_UNTRUSTED` | 停止安装，不绕过签名校验。 |
| `BUSINESS_DATA_STORAGE_FAILED` | 检查 app-local-data 和 SQLite 可写性。 |

## 7. 当前边界与未完成能力

本文档描述的是代码已经暴露的接口，不代表所有底层能力已经完整交付：

- 没有公共 HTTP 后端端口，也没有远程 REST API。
- Jianpian native、QuickJS sidecar、mpv、WebView2 是独立能力分支，是否可用由运行时和组件探测结果决定。
- `runtime_capability` 是探测接口，不会自动下载或补齐运行时。
- ClearKey、Shaka、mpv 和 WebView2 的完整生产播放栈不由这些 RPC 类型声明自动产生。
- Android DEX、JVM、Python 和 Electron 代码不属于 Tauri RPC 的同一运行时，不能把它们当作本接口的实现来调用。
- 任何发布能力都必须以真实构建、签名、Win11 E2E 和残留审计结果为准。

## 8. 维护规则

修改命令名、payload 字段、错误码或动作名时，必须同步：

1. `src-tauri/src/lib.rs` 及对应 Rust 模块；
2. `renderer/src/contracts.ts`；
3. `renderer/src/tauri-rpc.ts`；
4. 相关 `tests/tauri-*.test.ts`；
5. 本文档。

最低验证命令：

```powershell
npm test -- --run tests/tauri-contract.test.ts tests/tauri-source-session-contract.test.ts tests/tauri-playback-proxy-contract.test.ts tests/tauri-business-data-contract.test.ts tests/tauri-component-manager-contract.test.ts
git diff --check
```
