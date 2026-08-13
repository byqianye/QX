# G105 — Embedded Android Runtime V1

Date: 2026-08-13

## Final verdict

`EMBEDDED_ANDROID_RUNTIME_V1 = PASS`

The clean Windows 11 VM run provisioned the QX-isolated Android Runtime, started the headless AVD, installed the real Android Spider Host, loaded the real Jianpian DEX, resolved search/detail/playerContent, served the real HLS stream through LocalProxy, and played it in the packaged Chromium renderer for more than 20 seconds.

## Isolation

| Item | Result |
| --- | --- |
| Runtime root | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime` |
| SDK path | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk` |
| ADB path | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\platform-tools\adb.exe` |
| Emulator path | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\emulator\emulator.exe` |
| AVD path | `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd\QXSpiderRuntime.avd` |
| Physical isolated paths | `Q:\sdk`, `Q:\avd`, `Q:\state` |
| ADB server | QX-only port `5038` |
| VM | `D:\VMXXXXXXXXX\Win11\Windows 11 x64.vmx` |
| System adb used | NO |
| Existing `C:\Users\qiany\.android` used | NO |
| External Android phone used | NO |
| Android Studio required | NO |

The clean runner overwrote `PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME`, `ANDROID_USER_HOME`, and related Android variables. It used only QX-managed components. The connected physical phone was ignored.

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| Runtime Provision | PASS | Official command-line tools, platform-tools, emulator, API 35 Google APIs x86_64 image, and AVD were provisioned in the QX directory; SDK licenses were handled through the normal flow. |
| Headless Emulator | PASS | Dedicated QX AVD reached `device` and `sys.boot_completed=1`. |
| Host RPC | PASS | Real Host APK installed and RPC became online on the isolated AVD. |
| Jianpian Search | PASS | Real `csp_Jianpian` returned results for `流浪地球2`. |
| Detail | PASS | Real detail response contained playback lines. |
| PlayerContent | PASS | Real `playerContent` returned `parse=0`, `jx=0`, and a real media URL. |
| LocalProxy | PASS | Real Jianpian playlist, key, and TS segment were served by the local proxy. |
| hls.js PLAYING | PASS | Chromium reached `1920x1080`, with no fatal media error. |
| Packaged Playback | PASS | `currentTime` advanced from `0.098489` to `20.531358` seconds. |

## Final real playback evidence

```text
source          csp_Jianpian
keyword         流浪地球2
search          PASS
detail          PASS
playerContent   PASS
localMediaProxy PASS
hlsJs           PASS
probe.status    PLAYING
video           1920 x 1080
currentTime     0.098489 -> 20.531358
fatalErrors     []
proxy playlist  #EXT-X-KEY:METHOD=NONE
```

The source was not mocked and no media URL or Spider result was hard-coded. The real Jianpian HLS stream used AES-128 TS segments. LocalProxy decrypted the real TS segment and removed the malformed multichannel AAC track that Chromium rejected; it also changed the rewritten playlist key directive to `METHOD=NONE`, preventing hls.js from decrypting an already-decrypted segment a second time. Regression tests cover both the transform and the playlist/segment path.

## Source audit

The compatibility audit covered 39 configured sources:

```text
configured sources       39
searchable sources       33
class-load pass          37
init pass                37
search pass               3
detail pass               3
playerContent pass       1
real playable sources    1
```

The golden real playable source for this Goal is `csp_Jianpian`. The audit does not claim that every configured source is playable.

## Verification commands

| Command | Result |
| --- | --- |
| `npm test` | PASS — 104 files, 545 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run android-host:build` | PASS — Gradle build successful |
| `npm run android-host:check -- --qx` | BLOCKED after teardown — no resident device; the clean VM E2E Host RPC gate passed |
| `npm run prepack-check` | PASS |
| `npm run preview:smoke` | PASS |
| Electron-builder packaged directory | PASS |
| Clean Windows Android packaged E2E in VM | PASS |

## Changes verified in this Goal

- Added bounded Android Spider `init` retry handling for the observed transient initialization failure.
- Added real-world decimal-byte HLS playlist normalization before LocalProxy rewriting.
- Added real AES-128 MPEG-TS handling for browser playback, including the Chromium-incompatible multichannel AAC case.
- Added regression tests for TS normalization and already-decrypted TS playlist behavior.
- Kept clean packaged E2E isolated from system Android tools, existing `.android`, Android Studio, and the external phone.

## Remaining work

No G105 acceptance item remains open. The source audit correctly records that the other configured sources still require their own real validation; they are not included in the Jianpian PASS claim.

## Final status

`EMBEDDED_ANDROID_RUNTIME_V1 = PASS`
