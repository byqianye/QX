# QX影视 Windows Release Candidate V1

Version: `0.9.0-rc.1`  
Channel: RC

## Included

- TVBox/FongMi configuration sources
- Android DEX Spider Runtime with QX-isolated provisioning
- Real `csp_Jianpian` search, detail, playerContent, LocalProxy and HLS playback through the Setup package
- Local MP4 playback
- Per-user NSIS installer and Portable package

## Runtime behavior

Android Runtime is provisioned only after the user selects an Android DEX source and confirms the official Android SDK download and license flow. Runtime data is stored under `%LOCALAPPDATA%\QXMovie\android-runtime` and is not bundled into the installer.

The RC uses a dedicated ADB server on port 5038. It does not require Android Studio, a system SDK, or a connected phone. The Runtime Manifest locks the tested Windows x64 SDK component versions and directory hashes. Production logs are split into `main.log`, `runtime.log`, and `playback.log`, with redaction, size limits, and rotation.

## Verification status

- Unit tests, typecheck, build, Android Host build, Setup smoke, Portable smoke, Clean Install, Upgrade, and Uninstall: PASS.
- Real Clean E2E Jianpian Search/Detail/PlayerContent/LocalProxy: PASS; the latest HLS media probe reached the proxy but failed with media `errorCode=4` before PLAYING.
- An earlier independent packaged Jianpian retry passed the required probe (`1920x1080`, `currentTime` 0 -> 20.114664, `fatalErrors=[]`), but it does not override the latest Clean E2E failure.
- Clean E2E isolation audit: system adb, existing `.android`, Android Studio, and external phone did not participate; latest preflight was `cleanMachine=true`.

Strict G103 release status is therefore `FAIL`, not a fabricated PASS, because the latest real Clean E2E did not reach 20 seconds of media playback. See `WINDOWS-RC-FINAL-REPORT.md` for paths, hashes, commands, and evidence.

## Known limitations

- Some third-party sources may be offline or require user-provided authentication.
- `csp_Duopan` remains `AUTH_REQUIRED` until the user supplies valid credentials; no token or cookie is bundled.
- The package is unsigned when no code-signing certificate is supplied, so Windows SmartScreen may show a warning.
- First-time Android Runtime provisioning downloads the locked official components and requires sufficient disk space and Windows virtualization support.
