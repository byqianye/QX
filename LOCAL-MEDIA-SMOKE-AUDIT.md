# G102 Local Media Smoke Audit

Date: 2026-08-10

## Result

`localMedia=false` is fixed. Both Win-unpacked and Portable packaged smoke passed the real local MP4/video probe.

```text
local-file             present
HTTP Range             206 / 4 bytes
stream route           /api/local-media/stream/
videoWidth             16
videoHeight            16
currentTime            0 -> 1
readyState             4
fatalErrors            []
local history          position 3
```

The fixture contains real MP4 `ftyp`, `moov`, and `mdat` boxes. The packaged probe consumes the Range response body, waits for the local-media page and `<video>`, and verifies metadata, playback progress, and fatal media errors.

## Scope boundary

This audit covers local-media and packaged UI smoke. Real Android `csp_Jianpian` search/detail/playerContent, LocalProxy, HLS, and headless-runtime isolation are recorded in `PREVIEW-SMOKE-FINAL-REPORT.md` and `PACKAGED-UI-FINAL-E2E.md`.

```text
LOCAL_MEDIA_SMOKE = PASS
```
