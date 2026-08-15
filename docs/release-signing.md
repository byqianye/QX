# QX 影视正式签名发布清单

这份清单只适用于正式 Release。共享目录中的
`QX影视_0.9.0-rc.1_x64-unsigned-test.exe` 是未签名测试包，不能上传为正式发布资产。

## 1. SignPath 项目设置

在 SignPath Foundation 批准申请后，为 `byqianye/QX` 创建或绑定项目：

1. 项目仓库 URL：`https://github.com/byqianye/QX`。
2. 启用 GitHub Trusted Build System，并允许访问该仓库。
3. 配置 Windows x64 NSIS 的 artifact configuration。
4. 创建或确认 `release-signing` 签名策略，使用 SignPath Foundation 的公开代码签名证书。
5. 将 CI 用户加入该策略的 Submitters；需要人工审批时，将维护者加入 Approvers。

记录以下四个值，不要写入仓库：

- Organization ID
- Project slug
- Signing policy slug
- Submitter API token

## 2. GitHub Secrets

在仓库 `Settings → Secrets and variables → Actions` 中配置：

```text
SIGNPATH_API_TOKEN
SIGNPATH_ORGANIZATION_ID
SIGNPATH_PROJECT_SLUG
SIGNPATH_SIGNING_POLICY_SLUG
```

以下两个组件密钥已经配置，不要重新生成，除非同时废弃旧 Release 信任链：

```text
QX_COMPONENT_PRIVATE_KEY_BASE64
QX_COMPONENT_PUBLIC_KEY_BASE64
```

## 3. 触发发布

确认 `package.json` 版本为 `0.9.0-rc.1` 后，在已审查的提交上创建匹配标签：

```powershell
git tag v0.9.0-rc.1
git push origin v0.9.0-rc.1
```

工作流 `.github/workflows/tauri-signed-release.yml` 会依次执行：

1. 全量测试、Tauri 检查和无残留审计；
2. 构建 Windows x64 NSIS；
3. 生成并校验 QuickJS/mpv 组件清单；
4. 上传 unsigned installer 到 SignPath；
5. 等待 SignPath 返回 signed installer；
6. 收集 Authenticode、组件签名和 clean Win11 E2E 证据；
7. 通过严格门禁后创建 GitHub Release，并验证下载链路。

## 4. 验收

```powershell
gh run list --repo byqianye/QX --limit 5
gh release view v0.9.0-rc.1 --repo byqianye/QX
npm run g112:release-gate
```

只有当 `g112:release-gate` 返回 `PASS`，且 Release 中同时存在签名安装包、组件清单、组件签名、公钥和两个证据 JSON，才算正式发布完成。任何 `NotSigned`、缺失证据或旧安装包哈希都必须让发布失败。

## 5. 干净 Win11 runner

`windows-latest` 是 Windows Server，不满足本项目的 clean Win11 验收。发布工作流使用自托管标签：

```text
self-hosted, windows, x64, qx-clean-win11
```

将已打开的 Win11 虚拟机注册为该仓库的自托管 runner，并在创建标签前确认：

1. 卸载旧版 QX，保留用户数据目录，不把旧数据当成“干净安装”证据；
2. runner 服务可以正常上线，Node.js、Rust、7-Zip 和 WebView2 已可用；
3. 不让公开 Pull Request 使用这个 runner；发布工作流只响应维护者推送的版本标签。

发布工作流会在同一台 Win11 runner 上重新生成当前签名包的 clean-install、真实 Jianpian HLS 20 秒和 fresh-user upgrade 证据，然后才运行严格门禁。

注册脚本位于 `scripts/setup-qx-clean-win11-runner.ps1`。在 GitHub 仓库 Settings → Actions → Runners → New self-hosted runner 取得短期 registration token，在虚拟机管理员 PowerShell 中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& .\setup-qx-clean-win11-runner.ps1 -RegistrationToken "<短期 token>"
```

脚本只注册 runner 和安装服务；它不会删除 QX 用户数据。注册成功后在 GitHub Runner 列表确认标签 `qx-clean-win11` 为 Idle，再配置 SignPath 的四个 Secrets，最后推送版本标签。
