# QX影视 Windows Release Candidate V1

Version: 0.9.0-rc.1  
Channel: RC

## Included

- TVBox/FongMi configuration sources
- Android DEX Spider Runtime with QX-isolated provisioning
- Real `csp_Jianpian` search, detail, playerContent, LocalProxy and HLS playback
- Local MP4 playback
- Per-user NSIS installer and Portable package

## Runtime behavior

Android Runtime is not downloaded on first application launch. It is provisioned only after the user selects an Android DEX source and confirms the official Android SDK download and license flow. Runtime data is stored under `%LOCALAPPDATA%\QXMovie\android-runtime` and is not bundled into the installer.

The RC uses a dedicated ADB server on port 5038. It does not require Android Studio, a system SDK, or a connected phone.

The Android Runtime Manifest locks the tested Windows x64 SDK component versions and integrity hashes. Production logs are written under `%APPDATA%\\QX影视\\logs\\` as `main.log`, `runtime.log`, and `playback.log`, with size limits and rotation.

## Known limitations

- Some third-party sources may be offline or require user-provided authentication.
- `csp_Duopan` remains `AUTH_REQUIRED` until the user supplies valid credentials; no token or cookie is bundled.
- The package is unsigned when no code-signing certificate is supplied, so Windows SmartScreen may show a warning.
- First-time Android Runtime provisioning downloads approximately 2–3 GB from official Android sources and requires sufficient disk space and Windows virtualization support.

## Verification

See the generated `SHA256SUMS.txt` next to the two RC artifacts. Unit tests, typecheck, build, installer, Portable smoke, local media, Android Runtime provisioning, Clean Install, Upgrade and Uninstall checks passed. The latest Clean Android E2E passed Runtime/Host/Jianpian Search/Detail/PlayerContent/LocalProxy but failed the real HLS media probe (`errorCode=4`, no PLAYING); an earlier packaged retry passed. Strict G103 remains `FAIL`; see `WINDOWS-RC-FINAL-REPORT.md`.
