# Spike 66：DLNA / UPnP MediaRenderer 投屏

## Goal

在用户主动打开 Cast 面板并执行搜索时，通过 SSDP 发现局域网内的
`MediaRenderer`，读取设备描述和 AVTransport 能力，并提供受控的投屏会话。
本 Goal 不维护后台高频广播，也不声称支持真实第三方影视源解析能力。

状态：complete
依赖：G65 Push 播放链路；现有主进程 UI server、播放状态和本地媒体服务
范围：G66 DLNA/UPnP discovery、AVTransport SOAP、临时 CastMediaBridge、Cast UI、测试和文档

## 实现边界

- SSDP 仅在 `/api/cast/discover` 或 `/api/cast/refresh` 被调用时发送一次搜索；设备以 `deviceId`、名称、位置、型号、厂商、`lastSeen` 和能力集合进入主进程状态。
- `LOCATION` 只接受 HTTP、无用户凭据且解析后的地址全部属于本机/局域网范围；请求有超时和 XML 大小限制。DTD、DOCTYPE、外部实体和跨来源控制地址会被拒绝。
- AVTransport 使用 allowlist SOAP action：`SetAVTransportURI`、`Play`、`Pause`、`Stop`，以及设备声明支持时的 `Seek`、`GetTransportInfo`、`GetPositionInfo`。不支持的操作返回稳定的 `DLNA_UNSUPPORTED`。
- 没有请求头且设备可直接访问的媒体 URL 可以直投。需要 Cookie/Referer、或来源是本机地址时，使用只绑定当前会话的高熵 token bridge；bridge 只暴露当前媒体/字幕、GET/HEAD、有限时长和有限字节数，关闭会话或应用时立即撤销。
- 主进程只向远端媒体上游转发必要的受控请求头；SOAP 投给电视的 URL 不携带 Cookie 等私密头。文件系统路径和文件夹不会进入 renderer 或 bridge 路由。
- CastSession 只保存设备、媒体标题/类型、状态、开始时间、最近位置和安全错误；设备丢失后进入 `DLNA_DEVICE_LOST`，不做无限 SOAP 重试。

## 验收标准

1. fake SSDP + description/SCPD XML 可以发现设备并显示 friendly name、model、manufacturer 和 capabilities。
2. fake SOAP device 可以验证 SetAVTransportURI、Play、Pause、Stop、Seek、GetPositionInfo、GetTransportInfo；能力缺失时操作明确失败。
3. 恶意 LOCATION、公开地址、超大/带 DTD XML、超时和设备丢失均有稳定错误结果。
4. 本地媒体和带私有请求头的远程媒体经过临时 bridge；token 随机会话生成，过期、显式关闭、应用关闭后不可访问。
5. Cast 面板显示 Searching / Devices / Connected / Error，并能触发 Cast、Stop、Disconnect。
6. 打包 Electron E2E 验证发现、播放、停止、断开、重启状态和 bridge/sidecar 清理。

## 验证命令

```text
npx tsc --noEmit --pretty false
npx vitest run tests/cast-service.test.ts tests/desktop-ui.test.ts tests/vue-renderer.test.ts
npm run electron:e2e:package
```

## Checkpoint

`checkpoint: complete G66 DLNA cast`
