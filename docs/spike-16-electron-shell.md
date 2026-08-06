# Spike 16：Electron Windows 桌面壳

## 范围

本 Spike 选择 Electron，暂不实现 `playerContent`。Electron 主进程只负责窗口、JVM 运行时检查和生命周期；现有 `DesktopSpiderUiServer` 继续承载 URL/文件/原始 JSON 导入、首次信任确认以及首页、分类、搜索、详情调用。

## 运行结构

```text
BrowserWindow
    │ loadURL(local UI server)
DesktopSpiderUiServer
    └─ DesktopSpiderImportController
       └─ DesktopSpiderSession
          └─ DesktopSpiderClient → JvmSidecar → java.exe
```

窗口关闭时调用 `DesktopShellRuntime.close()`，再由 UI server 关闭 importer、session 和 JVM sidecar。JDK 不随应用打包；缺失时在创建 UI server 前显示明确错误。

构建阶段使用当前 JDK 编译 `fixtures/jvm` 为：

- `jvm-spider-host.jar`
- `jvm-spiders.jar`

打包时放到 `resources/electron-runtime`。这两个 Jar 仍是 Spike 用的 JVM-native Douban 适配，不代表已经支持所有 Android DEX Spider。

## 验证命令

```powershell
npm run typecheck
npm test
npm run electron:smoke
npm run electron:package:win
```

可运行包位置：

```text
dist/electron-package/QX影视-win32-x64/QX影视.exe
```

本地验收结果：

- Electron `43.3.0` 构建通过。
- `electron:smoke` 输出 `electron-smoke: ready`，并自动销毁 UI server 后退出。
- Windows x64 可运行包生成成功；直接启动包的 smoke 验证通过。
- `tests/electron-shell.test.ts` 覆盖 JDK 缺失、Jar 资源解析、重复启动复用和关闭只清理一次。
- `tests/spider-import.test.ts` 覆盖 URL 网络失败、无效配置、首次信任和重复导入；完整测试套件继续通过。

## 已知边界

- JDK 是外部前置条件，缺失不会自动下载；生产版需要在安装器或设置页提供 JDK 检测指引。
- 当前交付是可解压运行的 x64 包，不包含安装器、签名和自动更新。
- Douban 详情页明确禁用播放入口，`playerContent` 留待后续 Spike。
