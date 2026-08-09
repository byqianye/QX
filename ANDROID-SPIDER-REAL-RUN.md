# Android Spider Real Run

Final: **BLOCKED**
Generated: 2026-08-09T01:33:40.661Z

## Environment Doctor

- SDK: PASS (`C:\Users\qiany\.workbuddy\android-toolchain\sdk`)
- ADB: PASS (`C:\Users\qiany\.workbuddy\android-toolchain\sdk\platform-tools\adb.exe`)
- Device: BLOCKED
- Model: `unknown`
- Android: `unknown`
- SDK int: unknown
- ABI: `unknown`
- Boot completed: BLOCKED
- Emulator / AVD: not available
- Host APK / installed / RPC: PASS / BLOCKED / BLOCKED
- Host version: `unknown`

## Source and runtime

- Source: `csp_FeiMaoUC` / ⚡┃闪电┃优汐
- API: `csp_Duopan`
- Runtime: `android-dex`
- Keyword: `not supplied`
- Artifact: `C:\Users\qiany\AppData\Local\Temp\qx-android-spider-poc-cache\artifact-6d1c56d9626c2138fa41b2b6ebfc506ecc82e7fa5d3be70fdc7563d51b902e99.jar`, SHA Windows=`04f73a0bb4c79fd2547e6c7b488b82afcc20b42572f5ff3030b0c430cd0419ab`, SHA Android=`not verified`
- DexClassLoader: NOT_RUN, jarId=`not loaded`, dexCount=1, loadDuration=unknownms
- Resolved class: `not resolved`, classExists=false

## Lifecycle and real source calls

| Stage | Status | Evidence |
| --- | --- | --- |
| health | NOT_RUN | not run |
| loadJar | NOT_RUN | not run |
| createSpider | NOT_RUN | not run |
| init | NOT_RUN | not run |
| searchContent | NOT_RUN | not run |
| detailContent | NOT_RUN | not run |
| playerContent | NOT_RUN | not run |

## Search / detail / player summary

- Search: NOT_RUN, rawResponseLength=unknown, resultCount=unknown
- Detail: NOT_RUN, vodYearPresent=unknown, hasPlayFrom=unknown, hasPlayUrl=unknown, playLineCount=unknown
- Player: NOT_RUN, urlPresent=unknown, parse=unknown, jx=unknown, format=unknown, headerPresent=unknown

## RuntimeManager gate

AndroidDexRuntime.supported remains false; RuntimeManager and PlaybackSourceResolver are not advertised as Android-capable.

## Blockers

- `ANDROID_DEVICE_NOT_FOUND`
- `ANDROID_POC_KEYWORD_REQUIRED`
