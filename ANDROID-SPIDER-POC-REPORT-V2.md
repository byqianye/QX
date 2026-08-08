# Android Spider PoC Report V2

Status: **BLOCKED**
Generated: 2026-08-08T16:34:07.944Z
Config: `http://xn--z7x900a.net/`
Source: `csp_FeiMaoUC` / ⚡┃闪电┃优汐
API: `csp_Duopan`

## Artifact

- Windows path: `C:\Users\qiany\AppData\Local\Temp\qx-android-spider-poc-cache\artifact-6d1c56d9626c2138fa41b2b6ebfc506ecc82e7fa5d3be70fdc7563d51b902e99.jar`
- Size: 864852 bytes
- Windows SHA-256: `04f73a0bb4c79fd2547e6c7b488b82afcc20b42572f5ff3030b0c430cd0419ab`
- Android SHA-256: `not verified`
- Jar ID: `not loaded`

## Class resolution

- Not run.

## Lifecycle and real calls

| Operation | Status | Details |
| --- | --- | --- |
| init | NOT_RUN | not run |
| health | NOT_RUN | not run |
| loadJar | NOT_RUN | not run |
| createSpider | NOT_RUN | not run |
| searchContent | NOT_RUN | not run |
| detailContent | NOT_RUN | not run |
| playerContent | NOT_RUN | not run |

## Blockers

- `ANDROID_DEVICE_NOT_FOUND`
- `ANDROID_POC_KEYWORD_REQUIRED`

## Notes

- Host availability is based on ADB device reachability, package installation, and RPC health; no android-spider-host.exe check is used.
- Cleartext HTTP is disabled by default; a source that requires it is reported as CLEARTEXT_NOT_PERMITTED.
