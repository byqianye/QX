# 构建与打包

更新时间：2026-09-08

项目有两条发布路径。**最小体积和最快启动的目标固定使用 Tauri**；Electron 路径保留给旧版兼容和需要 bundled runtime 的场景。

## 最小 Tauri Windows x64 包

环境要求：

- Windows x64
- Node.js `>=22.5.0`
- Rust `>=1.77`、MSVC target 和 Windows SDK
- 可用的 WebView2；安装器使用 Tauri `downloadBootstrapper` 策略
- `QX_COMPONENT_PUBLIC_KEY_BASE64`
- `QX_COMPONENT_MANIFEST_URL`
- `QX_COMPONENT_SIGNATURE_URL`

先安装依赖：

```powershell
npm ci
```

执行最小包：

```powershell
npm run build:windows:minimal
```

脚本执行以下步骤：

1. 检查 Windows x64 和 release 组件签名环境变量。
2. 运行 `npm run typecheck`。
3. 运行 `npm run renderer:build`，生成 `dist/renderer`。
4. 运行 `tauri build --bundles nsis --target x86_64-pc-windows-msvc`。
5. 确认 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/` 生成安装器。
6. 在 `release/tauri-minimal/` 写出安装器副本和构建清单。

Rust 适配层包含在第 4 步的 Tauri release 可执行文件中。`src-tauri/src/*.rs` 不以 loose file 或 sidecar 形式复制；修改后的 Rust 适配、RPC、超时、取消和播放代理会随可执行文件一起重新编译。`bundle.resources` 必须为空，因此不会额外打包 Android、JRE、Python、mpv、aria2 或远程源配置。

构建清单会列出本次工作区修改的文件，并将其分类为：

- `runtimeIncluded`：编译进 Tauri 或进入 renderer 产物的运行时文件；
- `buildInputs`：参与本次构建但不会作为 loose file 进入安装器的配置、脚本和安装钩子；
- `repositoryOnly`：测试、文档和脚本源文件，留在仓库，不进入安装器；
- `generatedEvidence`：截图、日志和 JSON 证据，不进入安装器。

这样可以在保持体积最小的同时确认“所有运行时修改”已参与构建。把整个源代码仓库复制进安装器会增大体积、暴露测试和临时文件，也不会提升运行功能。

## 仅构建开发版 Tauri

```powershell
npm run tauri:dev
```

需要检查编译但不生成安装器时：

```powershell
npm run typecheck
npm run renderer:build
npm run check:rust
```

## Electron 兼容路径

以下命令会走 Electron renderer 和 bundled runtime，体积更大，不能用于“最小包”：

```powershell
npm run electron:package:win
npm run electron:installer:win
npm run dist:win:installer
```

它们可能包含固定 JRE、CPython、mpv、aria2 和 JVM Spider 资源。只有任务明确要求 Electron 兼容验收时才使用。

## 安装器验收

最小包生成后，在同一台 Windows x64 机器执行：

```powershell
npm run tauri:test-installer:e2e
```

验收至少检查安装、启动首页、配置恢复、卸载旧版本选项和退出清理。真实源播放必须使用 `scripts/tauri-cdp-canary.ts` 或专项脚本记录首帧、播放时长和缓冲，不用额外脚本调用 `video.play()` 掩盖产品失败。

`npm run tauri:test-installer` 是测试夹具路径，可能使用测试专用组件地址；它只能用于安装流程回归，不能替代带真实签名环境的 release 构建。

## 构建失败处理

- 缺少三个 `QX_COMPONENT_*` 变量：停止并补齐真实签名配置；不伪造值。
- 缺少 Rust target、Windows SDK 或 WebView2：记录环境阻塞，不修改源适配代码。
- 上游源 403/404/超时：在源状态台账中记录为当前不可用，只有拿到稳定响应格式才增加适配。
