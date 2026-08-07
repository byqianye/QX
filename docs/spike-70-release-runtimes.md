# G70 发布包内运行时

状态：完成。依赖：R70 checkpoint `4d42fd4`。

## 决策

Windows x64 发布包固定携带四类运行时：

- Eclipse Temurin 21.0.7+6 的 jlink 精简 JRE，仅包含 `java.base` 与 `java.net.http`；
- CPython 3.12.10 Windows x64 embeddable，使用 `python312._pth` 隔离用户 site 与 pip；
- mpv 固定构建 `21277b0ccf`；
- aria2 1.37.0 Windows x64。

`dist/electron-runtime/runtime-manifest.json` 记录 target、固定版本、来源归档 SHA-256、可执行文件相对路径、可执行文件 SHA-256 和许可证文件。启动时 packaged Electron 要求四类 entry 都存在且 hash 匹配；缺失返回 `BUNDLED_JRE_MISSING`，其他完整性失败返回 `RUNTIME_INTEGRITY_FAILED`。

发布启动链不读取系统 Java、`JAVA_HOME`、系统 Python、`PYTHONPATH`、用户 site 或 PATH 作为 fallback。开发环境仍允许显式外部 Java/Python fallback，且只在未打包时生效。

## 构建

发布构建必须设置 `QX_RELEASE_BUILD=1` 与 `QX_TEMURIN_JDK`，并提供本地已校验的 runtime asset directories。缺任何 runtime asset 会直接失败；不会生成“看似发布、实际依赖宿主机”的包。

本次使用的归档校验值：

```text
Temurin 21.0.7+6  38f4b9fa0b36def9812f6576fd45f6224630477db8c4e669ee78eaa35abb9195
CPython 3.12.10   4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3
mpv build         a49e0e1d821c7a907a7fda005d191359cec8a9f7885d631a4fe4ee30236b4e12
aria2 1.37.0      67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288
```

## 验证

```powershell
npm run typecheck
npx vitest run tests/runtime-manifest.test.ts tests/electron-shell.test.ts tests/diagnostics.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
$env:QX_TEMURIN_JDK = (Resolve-Path 'dist/release-assets/temurin-jdk/jdk-21.0.7+6').Path
$env:QX_RELEASE_BUILD = '1'
npm run electron:e2e:package
npm run electron:verify:no-jdk
```

结果：manifest/完整性测试通过；packaged first/restart E2E 通过；无系统 JDK 验证通过；关闭包内 JRE 时明确返回 `BUNDLED_JRE_MISSING`。
