# R70 发布基线与 G61 回归修复

状态：完成。依赖：G69 checkpoint `71cad93`。

## 目标

R70 固化进入发布工程阶段前的可重复基线，并修复 packaged first/restart E2E 中遗留的 `liveFailoverEpgContinuity=false`。

## 根因与修复

失败不是通过硬编码检查结果绕过的。Smart Channel 自动切换后，EPG timeline 的频道身份和显式映射均正确，但本地 XMLTV fixture 固定在前一天，按当前时间窗口查询时没有节目项。

修复包括：

- fixture 的 ETag、Last-Modified 和 XMLTV 节目窗口按当前 UTC 小时生成；
- packaged E2E 的 EPG 查询窗口按当前 UTC 小时对齐；
- 同一 live channel 的无范围 `setTimeline` 调用保留既有时间窗口，避免 failover 重新选择时移动用户的时间轴；
- 增加 fixture 动态时间与 timeline 窗口保留测试。

## 已验证基线

以下命令在 Windows x64 工作区执行：

```text
git diff --check                         pass
npm run typecheck                        pass
npm test -- --maxWorkers=1 --minWorkers=1 --reporter=dot
  historical R70 run: 69 files passed, 402 tests passed
npm run renderer:build                   pass (existing >500 kB warning)
npm run electron:build                  pass
npm run electron:e2e:package             pass (first run + restart run)
```

Packaged E2E 的 `liveFailoverEpgContinuity` 已由失败变为通过，同时保留了 Smart Channel 显式 EPG mapping、成员身份和进程清理断言。

当前工作区后续完整回归为 73 files / 415 tests passed；R70 的 checkpoint 仍为 `4d42fd4`。

## 已知发布前项

- 当前构建若未设置 `QX_TEMURIN_JDK` 仍会打印 development fallback；G70 负责移除发布包对外部 Java/Python 的依赖。
- renderer 单 chunk 仍超过 500 kB；R70 记录该基线，后续仅在对应 Goal 中处理。
- G76 的 clean Windows 验证仍是发布候选门槛；G73 已按用户授权的仓库侧自审路径完成。
