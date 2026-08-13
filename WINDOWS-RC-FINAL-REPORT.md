# G103 Windows Release Candidate V1 Final Report

Date: 2026-08-10  
Version: `0.9.0-rc.1`  
Channel: RC

## Final status

```text
EXECUTED_RC_GATES = PASS
EMBEDDED_ANDROID_RUNTIME_V1 = PASS
STRICT_G103_SPEC_REVIEW = PASS
WINDOWS_RC_V1 = PASS
```

The embedded Android Runtime, Host RPC, and real Jianpian Search -> Detail -> PlayerContent -> LocalProxy -> hls.js playback chain passed the strict Clean E2E. The final probe used the QX-isolated Runtime only and played real media for more than 20 seconds at 1920x1080 with no fatal media error.

## Release artifacts

| Artifact | Path | Size | SHA256 | Signed |
| --- | --- | ---: | --- | --- |
| Setup | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\rc\QX影视-RC-Setup-0.9.0-rc.1-x64.exe` | 185,643,976 | `15B1DDC971B3F7B5AA548DDC01CAB89DED59C063A23095DB8D7699E2B2E19E6E` | NO |
| Portable | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\rc\QX影视-RC-Portable-0.9.0-rc.1-x64.exe` | 167,899,244 | `A030E817457F9A311F922E7900DAE100CBB3B7676FB7B79B3A9B3AABCAFE0406` | NO |

Checksum file: `release/rc/SHA256SUMS.txt`  
Release notes: `RELEASE-NOTES-RC.md`, `WINDOWS-RC-RELEASE-NOTES.md`

## QX Android Runtime paths

- Runtime root: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime`
- SDK: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk`
- ADB: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\platform-tools\adb.exe`
- Emulator: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\emulator\emulator.exe`
- System image: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\system-images\android-35\google_apis\x86_64`
- AVD home: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd`
- AVD: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd\QXSpiderRuntime.avd`
- Android user home: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\state\android-user`
- ADB server: port `5038`
- Runtime version: `1.0.0`
- Host version: `1.0.0`
- Official SDK licenses: accepted through the normal `sdkmanager --licenses` flow after the product consent step; no license bypass was used.

The latest Clean E2E reached Runtime `READY`, booted the headless AVD, installed the Host, and connected RPC before the media probe. After testing, the generated Runtime remains at the QX-isolated Runtime root for reuse; the user's pre-existing `.android` was restored. No emulator or QX ADB server is left running at handoff.

Manifest component locks are present in `build/android-runtime-manifest.json`:

| Component | Version | SHA256 |
| --- | --- | --- |
| platform-tools | 37.0.1 | `F7B668DE557A79BBA6A75725C1778E99B0D6D3A657726EA8BF7D0A7150F38949` |
| emulator | 37.1.11 | `F4AD8BC8D5B4D3F87ACEBFC9C0FBDB63977DADCA9945CBA9B2162C6EB608BFCD` |
| platforms;android-35 | 2 | `F7C734FF1BB398863254444C41C9C696CB6AFEA19EE74E91229B18B065DFE049` |
| system-images;android-35;google_apis;x86_64 | 9 | `2471E4233554620BF5FE970B7C1BE6A14540FF5FCE872F7F6ED051F82DD6FBCF` |

## Isolation audit

| Check | Result |
| --- | --- |
| System adb used by QX runtime | NO (`systemAdbParticipated=false`) |
| Existing `.android` used by QX runtime | NO (`existingAndroidUserDirUsed=false`) |
| Android Studio used | NO (`androidStudioUsed=false`) |
| External phone connected/used | NO; only `emulator-5554` was selected |
| Android Studio required | NO |
| Clean-machine flag | `true`; latest preflight found no forbidden paths or PATH-visible Android commands; `runtimeRootExists=false` before provisioning |

The Clean E2E cleared/overrode `PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME`, `ANDROID_USER_HOME`, `ANDROID_EMULATOR_HOME`, and `ANDROID_SDK_HOME`. Runtime audit confirmed the QX ADB path, QX Android user home, and `emulator-5554`; no system adb, existing `.android`, Android Studio, or external phone participated.

## Runtime and real-source gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Runtime Provision / integrity | PASS | Official component versions and locked directory hashes validated; last successful Setup/Clean E2E reached `READY` |
| Headless Emulator | PASS | QX AVD booted; `emulator-5554`; WHPX ready |
| Host RPC | PASS | Host installed, started, and RPC ONLINE |
| Jianpian Search | PASS | Real `csp_Jianpian`, latest Clean keyword `庆余年 第二季` |
| Detail | PASS | Real `detailContent` |
| PlayerContent | PASS | Real `playerContent` |
| LocalProxy | PASS | Real `__qx_playback` HLS proxy |
| HLS playback through latest packaged RC | PASS | Real `csp_Jianpian`; `videoWidth=1920`, `videoHeight=1080`, `currentTime=0.071454 -> 20.377748`, `fatalErrors=[]` |
| HLS playback through latest Clean E2E | PASS | Real `csp_Jianpian`; `videoWidth=1920`, `videoHeight=1080`, `currentTime=0.185710 -> 20.450266`, `fatalErrors=[]` |
| Required final packaged playback gate | PASS | hls.js reported PLAYING for more than 20 seconds with no fatal media error |

No mock Spider, hardcoded media URL, fake Host, or fabricated result was used.

## Build and release verification

- `npm test`: PASS — 100 files, 525 tests.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run android-host:build`: PASS — Gradle Host unit tests and APK build.
- `npm run preview:smoke`: PASS.
- `npm run android-host:check:qx`: PASS — QX SDK/ADB/Emulator/AVD found, `emulator-5554` online, Host installed, RPC health online.
- `npm run rc:portable-smoke`: PASS.
- `npm run rc:clean-install`: PASS — install, shortcuts, packaged smoke, uninstall, user data retained.
- `npm run rc:upgrade`: PASS — marker and Runtime preserved.
- `npm run rc:uninstall`: PASS.
- `npm run rc:artifacts` with `QX_RC_SKIP_BUILD=1`: PASS.

Production logs are split into `main.log`, `runtime.log`, and `playback.log`, with redaction and rotation. The runtime log records the dedicated ADB/SDK/AVD/user-home paths used by the Clean E2E.

## Remaining blockers

None for the G103 RC acceptance gates. The emulator and QX ADB server were stopped after verification; the external phone was not used.

## Required final fields

```text
Runtime Provision: PASS
Headless Emulator: PASS
Host RPC: PASS
Jianpian Search: PASS
Detail: PASS
PlayerContent: PASS
Packaged Playback: PASS

是否使用系统 adb：NO
是否使用现有 .android：NO
是否连接外接手机：NO
是否需要 Android Studio：NO

EMBEDDED_ANDROID_RUNTIME_V1 = PASS
```

## Modified scope

G103-related changes cover the QX Runtime path resolver, locked Manifest/bootstrapper, supervisor/recovery, diagnostics/logging, Android DEX capability separation, unified source errors, Electron wiring, RC packaging and E2E scripts, Android Host build/check wiring, and their tests/reports. The worktree already contained earlier Goal changes; no reset, automatic commit, or push was performed.
