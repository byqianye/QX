# ENOENT Root-Cause Audit

Generated: 2026-08-08T16:34:07.944Z
Configuration source: `http://xn--z7x900a.net/`

ENOENT is not used as the user-facing root cause. Each failure is classified with the missing path and runtime context.

## Observed source

| Source | Runtime | Audit result | Root cause |
| --- | --- | --- | --- |
| ⚡┃闪电┃优汐 (csp_FeiMaoUC) | android-dex | BLOCKED | ANDROID_DEVICE_NOT_FOUND |

## Diagnostic fields

- errorCode: `ANDROID_DEVICE_NOT_FOUND`
- syscall: `unknown`
- missingPath: `unknown`
- sourceKey: `csp_FeiMaoUC`
- sourceName: ⚡┃闪电┃优汐
- runtimeKind: `android-dex`
- artifactUrl: `https://img2.gelonghui.com/library/f7c90-40d96eab-56f3-4c13-a248-8d80bcb9b83a.png`
- resolvedArtifactPath: `C:\Users\qiany\AppData\Local\Temp\qx-android-spider-poc-cache\artifact-6d1c56d9626c2138fa41b2b6ebfc506ecc82e7fa5d3be70fdc7563d51b902e99.jar`
- workingDirectory: `C:\Users\qiany\Documents\ChatGPT\QX影视`
- isPackaged: false
- resourcesPath: `unknown`

## Current configuration boundary

- Configured sites: 39
- Searchable sites: 33
- Android DEX sites not executable by the current desktop runtime: 37
- Other Android DEX sites were not collapsed into ENOENT; they remain `android_dex_runtime_not_available` until a Host exists.
