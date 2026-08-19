# QX影视 Preview Release Notes

版本：0.1.0 Preview V1
日期：2026-08-09

## 包含内容

- Windows x64 unpacked、NSIS installer、Portable 三种测试产物；
- Android Host APK 作为外部资源注入，不放入 ASAR；
- Embedded Android Runtime Bootstrapper、WHPX doctor、专用 AVD Supervisor、Host APK 和 Runtime Manifest；
- Android Runtime 设置页，支持自动/常驻/禁用、重启、修复、重装和卸载；
- 现有本地媒体、设置、历史、缓存和受控播放测试能力保持可用。

## 已知限制

- Android DEX Spider 的独立 Runtime 首次使用仍需从 Android 官方源下载组件并接受相关许可；
- 当前开发机尚未完成 clean Windows 首次 Provision 和专用 Emulator 的真实 Jianpian 播放硬门槛，因此不能将本 Preview 标为 `EMBEDDED_ANDROID_RUNTIME_V1=PASS`；
- 当前包未签名（`SIGNED=false`），不包含自动更新；
- 当前 Goal 的真实打包 Jianpian 播放因 Android Host `init` 超时且设备随后 ADB offline，尚未达到发布门槛；
- 外部影视源、用户 token、解析服务和第三方网络可用性不由本 Preview 保证；不内置凭据。
