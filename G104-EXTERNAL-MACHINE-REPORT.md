# G104 External Machine Report

Date: 2026-08-12  
Machine: VMware Workstation Win11 guest, VMX `D:\VMXXXXXXXXX\Win11\Windows 11 x64.vmx`  
Product: QX影视 `0.9.0-rc.1` Preview package

## Final status

```text
EMBEDDED_ANDROID_RUNTIME_V1 = PASS
```

The qualifying Guest run used the QX-isolated Runtime and a dedicated headless
`QXSpiderRuntime` AVD. It completed the real flow:

```text
QX Runtime Provision
  -> dedicated AVD
  -> Headless Emulator
  -> Host APK install
  -> Host RPC ONLINE
  -> real csp_Jianpian search
  -> detail
  -> playerContent
  -> LocalProxy
  -> hls.js PLAYING for >= 20 seconds
```

No mock Spider, hard-coded media URL, fake Host, or fabricated search/detail/player
result was used.

## Runtime paths

| Item | Guest path |
| --- | --- |
| Runtime root | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime` |
| SDK root | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk` |
| ADB | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\platform-tools\adb.exe` |
| Emulator | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\emulator\emulator.exe` |
| System image | `...\sdk\system-images\android-35\google_apis\x86_64` |
| AVD home | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd` |
| AVD | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd\QXSpiderRuntime.avd` |
| Android user home | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\state\android-user` |
| ADB server | QX-managed port `5038` |

The Guest isolation check found no `adb` command on PATH and no Android Studio
installation. A pre-existing `C:\Users\qiany\.android` directory exists on the
Guest, but the product supplied `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
`ANDROID_AVD_HOME`, `ANDROID_USER_HOME`, and `ADB_SERVER_SOCKET` pointing only to
the QX Runtime; it was not used. Only `emulator-5554` was selected during the
qualifying run. No external phone was connected.

## Acceptance gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Runtime Provision | PASS | Official command-line SDK components, platform-tools, emulator, API 35 image, AVD, and normal license flow completed |
| Headless Emulator | PASS | WHPX operational; `QXSpiderRuntime`, `emulator-5554`, `ro.boot_completed=1` |
| Host APK install | PASS | `com.qx.yingshi.androidhost` installed automatically |
| Host RPC | PASS | Product reached `hostOnline=true`, RPC connected, supervisor `READY` |
| Jianpian Search | PASS | Real `csp_Jianpian`, keyword `庆余年`, result count `20` |
| Detail | PASS | Real matched candidates `2`; detail success `2`; `hasPlayFrom=true`; `hasPlayUrl=true` |
| PlayerContent | PASS | Real first Jianpian candidate/episode selected; `playerContent` completed |
| LocalProxy | PASS | Proxy playlist/segment resources returned HTTP 200 |
| Packaged Playback | PASS | hls.js/HTML video reached PLAYING |

Playback probe:

```text
videoWidth       = 1920
videoHeight      = 1080
currentTimeStart = 0.124580
currentTimeEnd   = 20.601173
fatalErrors      = []
readyState       = 4
paused           = false
```

Real Jianpian playback payload summary from the same verified source flow:

```text
vod_id            = 54437
vod_play_from    = present (29 returned playback lines)
vod_play_url     = present (46 returned episodes on the selected line)
playerContent.url = present (real Jianpian HLS URL; LocalProxy consumed it)
parse             = 0
jx                = 0
header            = {}
format            = HLS (inferred from the real `.m3u8` URL)
```

The URL was obtained from the real DEX Spider response and then passed through
QX LocalProxy; it was not embedded in the test harness.

## Required command results

| Command | Result |
| --- | --- |
| `npm.cmd test` | PASS — 100 files, 529 tests |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run build` | PASS |
| `npm.cmd run android-host:build` | PASS — Gradle BUILD SUCCESSFUL |
| `npm.cmd run android-host:check` | BLOCKED when run after the packaged test because the test had already shut down the emulator; Host RPC was independently PASS in the packaged run |
| `npm.cmd run prepack-check` | PASS |
| `npm.cmd run preview:smoke` | PASS |
| `npm.cmd run preview:android-clean-e2e` | BLOCKED by the development host preflight because `C:\Users\qiany\.android` exists; this was not bypassed and was not used to claim the Guest PASS |
| Guest clean packaged E2E | PASS — isolated QX Runtime, dedicated AVD, real Jianpian, 20.48 seconds of measured advancement |

## Code changes for this acceptance

- Added one bounded retry for the verified transient Android Host null-`JsonObject`
  failure at the Android runtime and playback resolver boundaries.
- Prevented playback-source selection from reopening an already-ready Android
  session.
- Cleared stale Host `jarId` entries after unload and added regression coverage.
- Increased the default per-site timeout to cover cold Android Runtime startup.

The working tree already contained broader Goal-stage changes from earlier work;
this report does not claim ownership of unrelated pre-existing edits.

## Remaining note

The production `android-host:check` command reports `BLOCKED` if run with no active
device. That is a check-command state after the packaged harness shutdown, not a
failure of the qualifying E2E: the same clean run proved Host installation, RPC,
DEX loading, real source calls, LocalProxy, and playback end to end.
