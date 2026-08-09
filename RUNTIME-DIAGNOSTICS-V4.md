# Runtime Diagnostics V4

Status: **BLOCKED**
Generated: 2026-08-09T01:33:40.661Z

## Single-source diagnostics

| Check | Status | Evidence |
| --- | --- | --- |
| Android SDK | PASS | `C:\Users\qiany\.workbuddy\android-toolchain\sdk` |
| ADB | PASS | `C:\Users\qiany\.workbuddy\android-toolchain\sdk\platform-tools\adb.exe` |
| Device | BLOCKED | `ANDROID_DEVICE_NOT_FOUND` |
| Device facts | NOT_RUN | `unknown` |
| Boot completed | BLOCKED | ANDROID_DEVICE_BOOT_TIMEOUT or not run |
| Host APK | PASS | `C:\Users\qiany\Documents\ChatGPT\QX影视\android-spider-host\app\build\outputs\apk\debug\app-debug.apk` |
| Host installed | BLOCKED | package missing |
| RPC health | BLOCKED | HOST_OFFLINE |
| Artifact | NOT_RUN | `JAR_NOT_TRANSFERRED` dexCount=1 |
| Class | NOT_RUN | `CLASS_NOT_RESOLVED` |
| Init | NOT_RUN | not run |
| Search | NOT_RUN | not run |
| Detail | NOT_RUN | not run |
| Player | NOT_RUN | not run |

## Blockers

- `ANDROID_DEVICE_NOT_FOUND`
- `ANDROID_POC_KEYWORD_REQUIRED`
