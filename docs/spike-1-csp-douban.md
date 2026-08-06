# csp_Douban JVM 可行性 Spike 1

日期：2026-08-05

## 目标

使用真实公开配置中的 `csp_Douban`，验证 Windows x64 上的最小路径：

```text
读取配置 → 找到 csp_Douban → 下载并校验 Spider → 加载具体类 → init → homeContent
```

本次探针不会初始化或执行远程 DEX，只做 JVM 类加载尝试；Android 运行时也只检查 `adb` 和已连接设备。

## 实验结果

| 项目 | 结果 |
| --- | --- |
| 配置来源 | `http://xn--z7x900a.net/` |
| 目标站点 | `csp_Douban`，站点 key 为 `豆瓣` |
| FongMi 目标类 | `com.github.catvod.spider.Douban` |
| Spider 下载 | 864852 bytes，MD5 匹配 `f7c90ebd0a6632f3347eeeb8d9bd555e` |
| 包类型 | Android DEX Jar，包含 `classes.dex`，没有 JVM `.class` 条目 |
| JVM | JDK 21 可用，路径为 `C:\\Program Files\\Java\\jdk-21\\bin\\java.exe` |
| JVM 类加载 | `NOT_FOUND com.github.catvod.spider.Douban` |
| Android 运行环境 | `adb` 可用，但当前没有连接设备或模拟器 |
| `init → homeContent` | 未执行；在加载具体类之前已被阻断 |

## 结论

普通 JVM sidecar 不能直接加载这份真实 `csp_Douban` DEX，因此“内置 JRE 后直接运行现成 Spider Jar”不可行。当前实验也没有证明 Android DEX 运行时在 Windows 桌面端可行，因为没有 Android 设备/模拟器。

下一步只能二选一：

1. 评估并引入可在 Windows 上运行的 Android/DEX 兼容环境；
2. 基于 FongMi/CatVodSpider 的加载协议和依赖，把 Spider 运行时适配/重编译为真正的 JVM Jar。

在这两个方向确定前，不应继续做依赖 `csp_*` 的完整 UI 或播放链路。

## 可复现命令

```powershell
npm test -- --run tests/java-probe.test.ts
npm run typecheck
npm run spike:java
```
