# G102 Packaged UI Final E2E

Date: 2026-08-10

## Artifacts

| Artifact | Path | Result |
| --- | --- | --- |
| Win-unpacked | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\preview\win-unpacked\QX影视.exe` | PASS |
| NSIS Installer | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\preview\QX影视-Preview-Setup-0.1.0-x64.exe` | PASS |
| Portable | `C:\Users\qiany\Documents\ChatGPT\QX影视\release\preview\QX影视-Preview-Portable-0.1.0-x64.exe` | PASS |

## Real Jianpian playback

All Android playback rows below started from the packaged artifact and used the QX-managed headless AVD, not a source-tree app or external phone.

| Flow | Search | Detail | PlayerContent | LocalProxy | HLS | Video | Playback | Fatal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Win-unpacked | PASS | PASS | PASS | PASS | PASS | 1920x1080 | 20.377748s observed | none |
| Clean Windows E2E | PASS | PASS | PASS | PASS | PASS | 1920x1080 | 20.450266s observed | none |

The real source was `csp_Jianpian`, keyword `庆余年`, and every final probe reported `readyState=4`, `paused=false`, `playerStatus=playing`, and `fatalErrors=[]`.

## Installer E2E

```text
install       exit 0
installed E2E exit 0
desktop       present
start menu    present
uninstall     exit 0
removed       true
```

## Isolation evidence

```text
Runtime root  C:\Users\qiany\AppData\Local\QXMovie\android-runtime
SDK           C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk
ADB           C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\platform-tools\adb.exe
Emulator      C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk\emulator\emulator.exe
AVD           C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd\QXSpiderRuntime.avd
ADB server    tcp:5038
```

Clean E2E reported `cleanMachine=true`, `systemAdbParticipated=false`, `existingAndroidUserDirUsed=false`, and `androidStudioUsed=false`; preflight found no forbidden Android paths or PATH-visible Android commands.

```text
PACKAGED_UI_FINAL_E2E = PASS
```
