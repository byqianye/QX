# QX影视 Windows Release Candidate V1

Version: 0.9.0-rc.1  
Channel: RC

## Included

- TVBox/FongMi configuration sources
- Rust native HTTP adapter for `csp_Jianpian` search, detail, playerContent and playback
- Local MP4 playback
- Per-user NSIS installer and Portable package

## Runtime behavior

No Android/ADB/AVD component is shipped, downloaded, or started. Android DEX/JAR artifacts are recognized only for diagnostics and are rejected by the desktop execution path.

Production logs are written under `%APPDATA%\\QX影视\\logs\\` as `main.log`, `runtime.log`, and `playback.log`, with size limits and rotation.

## Known limitations

- Some third-party sources may be offline or require user-provided authentication.
- `csp_Duopan` remains `AUTH_REQUIRED` until the user supplies valid credentials; no token or cookie is bundled.
- The package is unsigned when no code-signing certificate is supplied, so Windows SmartScreen may show a warning.

## Verification

See the generated `SHA256SUMS.txt` next to the two RC artifacts. Historical package evidence predates this runtime cleanup; packaging and clean Windows E2E must be rerun before release. No Android Runtime E2E claim remains.
