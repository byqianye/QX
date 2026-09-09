# Spike 19：可播放源 `playerContent` 垂直切片

## 结论

Spike 19 已把 `playerContent(flag, id, vipFlags)` 从 JVM sidecar 接到桌面端 UI，并验证了真实的 HTTP 播放响应、请求头、超时和进程销毁。

本 Spike 使用 `csp_PlayableFixture` 作为 JVM-native 的可重复验证源。它是一个真正通过 `java.net.http.HttpClient` 请求 HTTP 的受控 fixture，不代表第三方影视供应商接入已经完成。

`csp_Douban` 继续是元数据/详情源，桌面端保持显示“Douban：无正片播放源”，不暴露播放入口。

## 播放源选择

公开配置中发现了带播放标记的 `csp_YGP`，但它的公共 Spider 资源不能作为当前 JVM Host 的输入：

- 配置项为 `csp_YGP`，`playerType` 为 `2`。
- 公共资源返回 HTTP 200，大小为 864,852 bytes。
- ZIP/DEX 指纹识别为 Android DEX Jar，而不是可由当前 `URLClassLoader` 直接加载的 JVM Jar。

因此没有把 `csp_YGP` 伪装成 JVM-native，也没有把 Android 依赖塞进当前 sidecar。它记录为后续独立 Emulator/DEX Spike 候选。当前 Spike 先用 `csp_PlayableFixture` 闭合桌面播放合同。

## 合同与映射

JVM Spider 合同：

```text
init(String ext)
playerContent(String flag, String id, List<String> vipFlags)
```

成功 JSON：

```json
{
  "parse": 0,
  "url": "https://media.example.invalid/fixture.m3u8",
  "header": {
    "User-Agent": "Spike19",
    "Referer": "https://source.example.invalid/"
  }
}
```

映射链为：

```text
Desktop UI
  -> DesktopSpiderSession.playerContent
  -> DesktopSpiderClient.playerContent
  -> NDJSON method=player
  -> JvmSpiderHost reflection
  -> PlayableJvmSpider.playerContent
  -> HTTP upstream
```

桌面 session 会校验 `parse` 和 HTTP(S) URL，并把 `header`/`headers` 对象或 `key=value&...` 字符串统一成 `headers`。播放入口只有在成功解析后才启用；当前 UI 将 URL 交给浏览器窗口打开，保留 parse 标记和请求头于播放状态，尚未实现带自定义请求头的视频内核。

## 隔离与错误行为

| 场景 | 结果 |
| --- | --- |
| 正常 player 响应 | 返回 URL、`parse` 和请求头，sidecar 保持运行 |
| 上游 HTTP 502 | 返回 `JVM_SPIDER_ERROR`，sidecar 保持运行 |
| player 请求超时 | 返回 `JvmSidecarTimeoutError`，sidecar 被终止 |
| 页面关闭/切换 | session 调用 `destroy`，sidecar 退出 |
| `csp_Douban` 调用 player | 返回 `PLAYBACK_UNAVAILABLE`，播放按钮保持禁用 |

## 验证

```powershell
npm run spike:player
npx vitest run tests/player-jvm.test.ts
npx vitest run tests/desktop-ui.test.ts tests/spider-import.test.ts
```

本轮结果：`npm run spike:player` 通过，`npm test` 通过（55/55），`npm run electron:e2e:package` 通过；后者复验了打包版 Douban 导入、真实搜索→详情和窗口关闭后的 sidecar 退出。

Spike 19 的下一步不是给 Douban 增加播放，而是二选一：

1. 为真实 JVM-native 播放 Spider 增加配置和适配；或
2. 为 `csp_YGP` 这类 Android DEX Spider 单独做 Emulator/DEX 运行时评估。

补充状态（2026-08-17）：`csp_YGP` 已根据公开 `www.6huo.com` HTML 合同移入独立 Rust 适配器，不加载或执行原 Android DEX。Rust 适配只接受固定的电影/预告数字路径，并从播放页脚本提取明确 `.mp4` 直链；这不改变本 Spike 关于 JVM-native 与 Android DEX 运行时隔离的结论。
