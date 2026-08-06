# Android/DEX 与 JVM 适配路线评估

日期：2026-08-05

## 结论先行

两条路线都能在“开发机上继续验证”，但都不适合作为当前 Windows 自用版的默认内置运行时：

- Android/DEX 路线需要完整 Android 虚拟设备或真实 Android 设备，不是一个可以随 Electron 一起复制的轻量 JRE sidecar。
- JVM Jar 路线不能直接兼容任意现成 `csp_*` DEX；对本次真实 `csp_Douban`，需要重写/适配 Android API、CatVod 网络运行时和混淆后的依赖，已经不是替换类加载器。

当前建议：先把 Windows 桌面端的 Spider Host 定义为 JVM-native/HTTP/QuickJS/Python；`csp_*` 先作为需要外部 Android 运行环境的实验能力，不在一期承诺通用兼容。

## 本机环境

| 项目 | 结果 |
| --- | --- |
| Windows | Windows 10 Pro for Workstations，当前显示 25H2，AMD64 |
| CPU 虚拟化固件 | 已启用 |
| SLAT | 支持 |
| Windows Hypervisor | 当前未检测到运行中的 hypervisor |
| JDK | JDK 21，安装在 `C:\\Program Files\\Java\\jdk-21`，未默认加入 PATH |
| adb | 33.0.0，可执行 |
| Android SDK / emulator / sdkmanager | 未安装 |
| adb 设备 | 0 |

## 路线 A：Android/DEX 运行环境

### 已确认

官方 Android Emulator 支持 64 位 Windows 10 或更高版本；Windows 上的加速路径使用 Windows Hypervisor Platform 或 Android Emulator Hypervisor Driver，并要求 CPU 虚拟化扩展与 SLAT。参考：[Android Emulator 系统要求](https://developer.android.com/studio/run/emulator) 和 [官方加速说明](https://developer.android.com/studio/run/emulator-acceleration)。

本机具备 CPU 虚拟化和 SLAT，但没有 SDK、AVD、emulator 或活动 hypervisor，所以目前还没有完成 `adb → Android → csp_Douban` 的执行验证。

Windows Subsystem for Android 不能作为本项目的 Windows 10 基线：微软文档将其适用范围写为 Windows 11，且 WSA/Amazon Appstore 已于 2025-03-05 从 Microsoft Store 下架。[微软支持说明](https://support.microsoft.com/en-us/windows/apps/mobileapps/install-mobile-apps-and-the-amazon-appstore-on-windows)

### 对产品的影响

Android Emulator 可用于开发机验证，但要随桌面应用交付至少需要处理：

- Android 系统镜像、AVD 存储和初始化；
- WHPX/AEHD、重启、管理员权限和其他虚拟化软件冲突；
- 启动时间、内存、GPU/软件渲染和用户机器差异；
- Electron 进程与 Android guest 之间的 RPC、端口和生命周期；
- Android 与 Spider 的许可证、镜像分发和更新问题。

因此它更像“外部测试后端”，不是当前自用版的内置 sidecar。若要继续验证，只应先在开发机安装 SDK/创建一个 AVD，验证 `csp_Douban`，不应把这一步直接变成产品安装器功能。

## 路线 B：适配/重编译为 JVM Jar

### 构建链不是 JVM Jar

官方 [CatVodSpider](https://github.com/FongMi/CatVodSpider) 的构建链是 Android Gradle Plugin：先构建 release APK，再用 apktool 解包筛选 smali，最后重新生成 `custom_spider.jar`。产物本质仍是 DEX。

FongMi 的 [正式加载器](https://github.com/FongMi/TV/blob/master/app/src/main/java/com/fongmi/android/tv/api/loader/JarLoader.java) 也明确使用 `dalvik.system.DexClassLoader`，并按 `csp_Douban` 拼接加载 `com.github.catvod.spider.Douban`；这不是 `URLClassLoader` 可以替换的同构接口。

### 真实 DEX 静态审计

对本次公共 Spider Jar 使用 jadx 1.5.6 做静态反编译：

| 项目 | 结果 |
| --- | --- |
| 处理的 DEX 类 | 580 |
| 输出 Java 文件 | 787 |
| jadx 报告错误 | 3 |
| `Douban.init(Context, String)` | 方法体为空 |
| `Douban.homeContent(boolean)` | 依赖混淆后的 CatVod 网络、JSON 和结果模型辅助类 |
| `merge` 包 Java 文件 | 742 |
| `merge` 包中引用 Android API 的文件 | 73 |
| `Douban` 直接 Android 依赖 | `android.content.Context`；同时继承 CatVod `Spider` |

`init` 为空只能说明这个具体 Spider 初始化逻辑简单，不能消除基类和网络运行时的 Android 依赖。真实 `Douban` 还使用了混淆后的 `merge` 类、OkHttp、`org.json`/Gson 风格结果模型和加密字符串；公开配置只给出 DEX，不提供可维护的原始 Spider 源码。

### JVM 适配的真实工作量

若只针对“有源码、依赖简单”的 Spider，可以设计新的 JVM-native API：

```text
SpiderContext + JVM HTTP client + JSON/result model
        ↓
重新编译 source-available Spider
        ↓
JVM .class Jar + URLClassLoader
```

但这不能把任意公共 Android DEX 自动变成兼容 JVM Jar。对 `csp_Douban`，至少要重写 Android Context 签名、替换 CatVod Android 网络/工具依赖、处理混淆后的合并类，并重新验证每一个网络接口和结果格式。

## 路线决策

| 方案 | 兼容现成 DEX | Windows 10 自包含 | 当前建议 |
| --- | --- | --- | --- |
| 普通 JRE + URLClassLoader | 否 | 是 | 排除 |
| 内置 Android Emulator/AVD | 理论上可以 | 很差 | 仅开发验证 |
| 外部 Android 设备 + adb | 可以 | 否 | 可做开发后端 |
| 通用 DEX→JVM 自动转换 | 不可靠 | 理论上是 | 排除 |
| source-available Spider 重编译为 JVM | 仅限可控源码 | 可以 | 可作为后续专项 |
| HTTP/QuickJS/Python JVM Host | 不兼容现成 `csp_*` | 可以 | 一期默认路线 |

## 下一步边界

继续做 Android 路线需要用户明确允许安装 Android SDK、下载系统镜像并可能启用 WHPX/重启；这些属于开发机系统变更，我本次没有执行。

在不做系统变更的前提下，下一步最有价值的是实现 source-available Spider 的 JVM-native 示例和 Host 接口，而不是继续尝试把这份混淆 DEX 硬转成 JVM Jar。
