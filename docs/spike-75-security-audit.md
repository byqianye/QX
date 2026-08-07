# G75 发布安全审计

状态：完成（自动化审计范围）。依赖：G74。

## 结果

- `npm audit --audit-level=high`：0 vulnerabilities；
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities；
- release runtime manifest 的 JRE、CPython、mpv、aria2 四项均 `bundled=true` 且有 executable SHA-256；
- packaged Electron 通过 manifest 校验后才创建 shell，发布模式不允许 external Java fallback；
- Python packaged environment 清除 `PYTHONHOME`、`PYTHONPATH`、`PYTHONUSERBASE`、`VIRTUAL_ENV`，并设置 `PYTHONNOUSERSITE=1`；
- mpv/aria2 使用参数数组和 `shell=false`；aria2 仅绑定 localhost、随机 RPC port、随机 secret；
- 受限 secret pattern scan 未发现凭据。命中的 `password` 参数名、RPC secret 生成代码和测试 fixture 均不是硬编码凭据。

## 发布边界

本审计不包含代码签名证书、外部 clean VM、真实第三方影视源、DRM 或 Android DEX；这些仍属于后续门槛或明确非范围。
