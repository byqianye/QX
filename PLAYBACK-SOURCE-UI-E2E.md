# Playback Source UI E2E

## Real flow

1. Packaged QX imports `fixtures/android-ui-real-config.json`.
2. Douban is used for metadata search/detail.
3. The UI playback-source action waits for `Android Runtime READY`.
4. The UI exposes and selects the real `csp_Jianpian` candidate.
5. The UI selects an episode and invokes real Android `playerContent`.
6. LocalProxy serves the returned HLS URL and hls.js plays it.

## Final result

PASS

- Search: PASS
- Detail: PASS
- PlayerContent: PASS
- LocalProxy: PASS
- hls.js: PASS
- Video: 1920x1080
- Playback: 24.008633 seconds
- Fatal media error: none

The E2E uses the real Android DEX source and does not inject Spider results or hard-code a media URL.
