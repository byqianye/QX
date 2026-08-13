# Windows Preview Smoke Test

Date: 2026-08-09

## Build and packaged checks

- `npm run build`: PASS
- `npx electron-builder --config electron-builder.preview.yml --dir --x64`: PASS
- Packaged Android playback: PASS
- Clean Windows Android E2E: PASS

The general `npm run preview:smoke -- release/preview/win-unpacked/QX影视.exe` suite completed all relevant packaged checks except the pre-existing `localMedia=false` check. The script therefore exited with FAIL even though the Android Runtime and playback checks passed. This Goal does not change local-media behavior.

## Android Runtime-specific smoke evidence

- Embedded MP4/HLS and proxy-HLS checks: PASS
- Real Jianpian VOD playback: PASS
- Video dimensions: 1920 x 1080
- Continuous playback: 24.008633 seconds
- Fatal media errors: 0
- LocalProxy resources observed: yes

The unrelated local-media smoke failure is reported as-is and is not counted as Android Runtime PASS evidence.
