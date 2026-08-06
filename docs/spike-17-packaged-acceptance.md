# Spike 17：打包版真实验收与生命周期加固

## 验收范围

本 Spike 不实现 `playerContent`。验收对象是 `dist/electron-package` 中的 Windows x64 exe，而不是只在 Node/Vitest 中运行的 UI server。

打包 E2E 使用隔离的 Electron `userData`，并连续启动两次：

1. 第一次通过配置 URL、文件路径和原始 JSON 依次导入；验证首次警告、取消、确认信任、真实 Douban 搜索和详情。
2. 关闭并销毁 session/sidecar 后，用同一 userData 重启 exe；验证相同来源无需再次确认。

## 验证命令

```powershell
npm run electron:e2e:package
npm run electron:package:win
npm run electron:verify:no-jdk
npm run electron:verify:network-timeout
```

本次结果：

- 两轮打包 E2E 均通过。
- 搜索结果 `msearch:36246195` 进入同一条详情。
- 两轮 sidecar PID（本次记录为 `48256`、`61644`）在窗口关闭后均已退出。
- URL、文件、JSON 导入、取消、重复启动和重启后信任均通过。
- 强制无 JDK 返回 `JDK_NOT_FOUND`，不会弹出阻塞式错误窗口。
- 延迟配置 URL 返回 `IMPORT_FETCH_ERROR`，网络超时被限制在导入层。

## JDK 与精简 JRE 决策

使用当前 JDK 21.0.7 的 `jlink` 生成只包含 `java.base,java.net.http` 的运行时：

- 精简 JRE：约 `29.7 MiB`。
- 当前 Electron x64 包：约 `356.6 MiB`。
- 精简 JRE 已实际运行 `JvmSpiderHost` 的 `init → destroy` RPC。

正式包决定采用“随包携带精简 JRE”，原因是增加约 30 MiB，却可以消除用户机器必须预装 JDK/JRE 的启动失败；外部 Java 保留为开发环境和打包机 fallback。当前 Spike17 的验收包仍沿用外部 JDK，下一步只需把该 `jlink` 产物接入 `package-runtime` 和运行时解析优先级。

精简 JRE 的后续工程责任是固定 OpenJDK/Temurin 发行版、补丁更新和包内版本升级；不直接把本机 Oracle JDK 目录当作发布资产。
