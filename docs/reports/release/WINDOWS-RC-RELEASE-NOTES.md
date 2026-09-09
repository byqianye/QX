# QX影视 Windows Release Candidate V1

Version: `0.9.0-rc.1`  
Channel: RC

## Included

- TVBox/FongMi configuration sources
- Rust native HTTP adapter for `csp_Jianpian` search, detail, playerContent and playback
- Local MP4 playback
- Per-user NSIS installer and Portable package

## Runtime behavior

No Android/ADB/AVD component is shipped, downloaded, or started. Android DEX/JAR artifacts are recognized only for diagnostics and are rejected by the desktop execution path. Production logs are split into `main.log`, `runtime.log`, and `playback.log`, with redaction, size limits, and rotation.

## Verification status

- Unit tests and typecheck from the pre-cleanup build are historical only; packaging and clean Windows E2E must be rerun after this runtime cleanup.

The RC release status is not certified by this historical note; rerun the current packaging and clean Windows E2E before release.

## Known limitations

- Some third-party sources may be offline or require user-provided authentication.
- `csp_Duopan` remains `AUTH_REQUIRED` until the user supplies valid credentials; no token or cookie is bundled.
- The package is unsigned when no code-signing certificate is supplied, so Windows SmartScreen may show a warning.
