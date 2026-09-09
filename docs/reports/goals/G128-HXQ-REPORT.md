# G128 csp_Hxq（韩圈）专项适配报告

验证日期：2026-09-05
配置来源：http://xn--z7x900a.net/
站点：韩圈（`csp_Hxq`）

## 结果

当前 ext 为：`http://www.小不点.com/api/2026/fishhxq.php`。本次从默认配置解码后，使用以下地址探测：

- `http://www.xiaobudian.com/api/2026/fishhxq.php`：HTTP 502
- `https://www.xiaobudian.com/api/2026/fishhxq.php`：TLS 握手失败
- 中文域名 HTTP：HTTP 502
- 中文域名 HTTPS：TLS 握手失败

因此无法取得真实响应，无法确认请求方法、参数、鉴权/签名、返回结构或播放字段。

## 适配决策

本次不新增猜测性适配器，也不把 `csp_Hxq` 降级为普通 CMS 或声明式 HTTP 源。项目会继续将它报告为“待合同”，避免空结果或错误页面被误判为可用源。

## 需要的后续输入

当源站恢复并能提供真实响应后，再补齐 `home → search → detail → player` 五阶段合同测试；如果它依赖动态签名、加密、HTML 或脚本，应进入隔离专用适配器流程。
