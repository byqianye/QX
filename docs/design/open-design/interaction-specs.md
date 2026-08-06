# QX 交互规格

## 状态模型

```text
idle → loading → success → playing ↔ paused
             ├→ proxy-required → trust-confirmation → loading
             └→ unavailable/error → retry | switch-line | diagnostics
```

renderer 接收适配器返回的状态，不根据 URL 字符串猜测是否需要代理。

## 来源与信任

来源选择显示名称、角色和连接状态，不显示密钥或完整内部地址。首次使用未确认来源、首次启用 LocalProxy 或适配器要求用户确认时，打开 `TrustConfirmationDialog`；确认失败时保留弹窗，不写入持久化信任状态。

## 播放恢复

用户从详情点击播放后，renderer 请求解析；适配器返回 MP4/HLS、代理需求、安全引用和脱敏诊断。需要代理时先确认再准备播放。播放失败时必须区分：

| 结果 | 主动作 | 次动作 |
| --- | --- | --- |
| `Proxy Required` | 启用代理并重试 | 换一条线路 |
| `Playback Unavailable` | 重试当前线路 | 切换线路 |
| HLS 清单失败 | 重试 | 查看诊断 |
| Jellyfin 鉴权失效 | 打开设置 | 查看诊断 |

不自动循环重试，不把代理前置条件显示成播放器损坏，也不把线路失效误导成设置问题。

## 诊断与边界

`DiagnosticPanel` 只复制脱敏摘要：时间、来源类型、协议、步骤状态和错误码；剔除 token、cookie、完整 URL 和本机路径。Vue renderer 只调用 typed IPC；Electron main/preload 管理 allowlist、LocalProxy 生命周期和服务适配器。

键盘顺序为侧栏 → 搜索 → 筛选 → 媒体卡 → 抽屉/播放器；抽屉和弹窗支持 Escape，关闭后恢复触发元素焦点。

## G26 合同冲突记录

现有 G25 typed IPC 没有独立的“启用代理”命令；因此 UI 的“启用代理并重试”主动作复用既有播放器重试请求，由 Electron main 的 LocalProxy 准备逻辑按业务返回的 headers 决定是否建立代理会话。没有新增伪造的代理能力或第三方接口；若业务后续提供独立命令，再绑定到该动作。
