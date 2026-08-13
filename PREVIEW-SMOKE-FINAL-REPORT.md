# G102 Preview Smoke Final Report

Date: 2026-08-10

## Final status

```text
PREVIEW_SMOKE_FINAL = PASS
EMBEDDED_ANDROID_RUNTIME_V1 = PASS
```

The final evidence uses the real `csp_Jianpian` source. No mock Spider, fake Host, hard-coded media URL, or fabricated search/detail/player result was used.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | PASS | 100 files / 525 tests |
| `npm run typecheck` | PASS | TypeScript completed |
| `npm run build` | PASS | Electron and renderer build |
| `npm run android-host:build` | PASS | Host APK and runtime manifest built |
| `npm run android-host:check:qx` after QX emulator start | PASS | QX SDK/ADB, `emulator-5554`, installed Host APK and Host RPC health all passed |
| Preview smoke | PASS | Packaged local MP4/video probe passed |
| NSIS Installer E2E | PASS | Install, packaged E2E, shortcuts, uninstall and removal all passed |
| Win-unpacked Android playback | PASS | Jianpian search/detail/playerContent/LocalProxy/HLS and 20-second playback passed |
| Portable Android playback | PASS | Same real Jianpian flow passed under the Portable artifact |
| Clean Windows Android E2E | PASS | QX runtime provision, headless AVD, Host RPC and real playback passed |

## Required acceptance gates

| Gate | Result |
| --- | --- |
| Runtime Provision | PASS |
| Headless Emulator | PASS |
| Host RPC | PASS |
| Jianpian Search | PASS |
| Detail | PASS |
| PlayerContent | PASS |
| Packaged Playback | PASS |

## Real Android playback evidence

```text
source             csp_Jianpian
keyword            庆余年 第一季
search             PASS
detail             PASS
playerContent      PASS
localMediaProxy    PASS
hlsJs              PASS
videoWidth         1920
videoHeight        1080
currentTime        0.071454 -> 20.377748 (Win-unpacked)
fatalErrors        []
playerStatus       playing
readyState         4
```

The final Clean Windows Android E2E reached `20.450266` seconds from `0.185710`; all probes reported no fatal media error.

## QX Android Runtime isolation

```text
Runtime root  C:\Users\qiany\AppData\Local\QXMovie\android-runtime
SDK path      C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk
ADB path      C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\platform-tools\adb.exe
Emulator path C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\emulator\emulator.exe
AVD path      C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd\QXSpiderRuntime.avd
ADB server    tcp:5038
```

```text
system adb used        NO
existing .android used NO
external phone used    NO
Android Studio needed  NO
```

Clean E2E preflight reported `cleanMachine=true`, no existing forbidden Android paths, no PATH-visible Android commands, and `runtimeRootExists=false` before provisioning. It explicitly cleared/overrode Android variables and reported `systemAdbParticipated=false`, `existingAndroidUserDirUsed=false`, and `androidStudioUsed=false`. The only playback device was the QX-managed headless emulator.

## Local media smoke

```text
HTTP Range       206 / 4 bytes
local-file       present
stream route     /api/local-media/stream/
videoWidth       16
videoHeight      16
currentTime      0 -> 1
readyState       4
fatalErrors      []
```

The packaged local-media path uses a real MP4 fixture and a real `<video>` probe.
