# QX影视 Spike 0 结果

日期：2026-08-05

## 已验证

| 探针 | 结果 |
| --- | --- |
| 配置解析 | 通过。支持普通 JSON、`tvbox://` Base64、FongMi AES-CBC 外包。 |
| 肥猫公开配置 | 通过。HTTP 200，解出 39 个站点、2 个直播源、4 个解析器、14 条规则。 |
| 首次信任 | 通过。远程配置包含 Spider 代码时首次导入要求确认；确认后按来源记录信任。 |
| QuickJS | 通过。QuickJS ESM、`default`/`__jsEvalReturn` 入口、同步 `req()` 宿主注入均可运行。 |
| Python | 通过。Python sidecar 通过本机 HTTP `/rpc` 调通 `init`、`home`、`search`。 |
| Java | 阻断。肥猫配置声明的 Spider MD5 匹配，但下载物是包含 `classes.dex` 的 Android DEX Jar。 |

## 可复现命令

```powershell
npm install
npm test
npm run typecheck
npm run spike:config
npm run spike:js
npm run spike:python
npm run spike:java
npm run spike
```

## 关键结论

肥猫配置可以作为真实配置解析样本，但不能直接证明 Windows JRE sidecar 能运行其 `csp_*` 站点。现有 FongMi Spider 包是 Android DEX，不是 JVM `.class` Jar；此前探针按 PATH 未发现 Java，后续 Spike 已确认本机另有未加入 PATH 的 JDK 21。

因此下一步不能简单地“下载 JRE 后加载现成 Jar”。需要在 Java 兼容层上重新决策：使用能执行 Android DEX 的运行时，或把 Spider 源码/依赖适配为真正的 JVM Jar。这个决定会影响一期是否仍能承诺 `csp_*` 兼容。

## 安全边界

Spike 不执行肥猫配置中的远程 Spider，只读取配置、校验 MD5 并识别 Jar 格式。正式导入流程必须在用户明确确认后才允许运行远程 JS/Python/Java 代码。
