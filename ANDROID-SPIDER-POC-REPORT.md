# Android Spider PoC Report

Status: **BLOCKED**
Generated: 2026-08-08T16:44:39.282Z
Config: `http://xn--z7x900a.net/`
Source: `csp_FeiMaoUC` / ⚡┃闪电┃优汐
API: `csp_Duopan`

## Artifact

- URL: `https://img2.gelonghui.com/library/f7c90-40d96eab-56f3-4c13-a248-8d80bcb9b83a.png`
- Local path: `C:\Users\qiany\AppData\Local\Temp\qx-android-spider-poc-cache\artifact-6d1c56d9626c2138fa41b2b6ebfc506ecc82e7fa5d3be70fdc7563d51b902e99.jar`
- Runtime: android-dex
- SHA-256: `04f73a0bb4c79fd2547e6c7b488b82afcc20b42572f5ff3030b0c430cd0419ab`

## Required operations

| Operation | Status | Details |
| --- | --- | --- |
| health | not_run |  |
| loadJar | not_run |  |
| createSpider | not_run |  |
| init | not_run |  |
| searchContent | not_run |  |
| detailContent | not_run |  |
| playerContent | not_run |  |

## Normalized failure

```json
{
  "code": "ANDROID_DEVICE_NOT_FOUND",
  "message": "Android Spider Host prerequisites are unavailable: ANDROID_DEVICE_NOT_FOUND",
  "sourceKey": "csp_FeiMaoUC",
  "sourceName": "⚡┃闪电┃优汐",
  "runtime": "android-dex",
  "siteKey": "csp_FeiMaoUC",
  "artifactUrl": "https://img2.gelonghui.com/library/f7c90-40d96eab-56f3-4c13-a248-8d80bcb9b83a.png",
  "artifactPath": "C:\\Users\\qiany\\AppData\\Local\\Temp\\qx-android-spider-poc-cache\\artifact-6d1c56d9626c2138fa41b2b6ebfc506ecc82e7fa5d3be70fdc7563d51b902e99.jar",
  "rootCause": "ANDROID_DEVICE_NOT_FOUND",
  "workingDirectory": "C:\\Users\\qiany\\Documents\\ChatGPT\\QX影视",
  "isPackaged": false,
  "stack": "Error: Android Spider Host prerequisites are unavailable: ANDROID_DEVICE_NOT_FOUND\n    at runAndroidSpiderPoc (C:\\Users\\qiany\\Documents\\ChatGPT\\QX影视\\src\\spikes\\android-spider-poc.ts:251:31)\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)"
}
```

The selected real csp_* source was not reported as executable; the missing prerequisite remains explicit.
