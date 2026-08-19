# Packaged Real Android Playback Test

Date: 2026-08-12

## Result

PASS

The qualifying VMware Guest path was:

```text
Preview EXE -> QX Android Runtime -> Headless AVD -> Android Host RPC
-> real csp_Jianpian DEX -> search/detail/playerContent
-> LocalProxy -> hls.js -> HTML video
```

Real source: `csp_Jianpian`  
Keyword: `庆余年`

| Check | Result |
| --- | --- |
| Search | PASS — 20 results |
| Detail | PASS — 2 matched candidates, both with play fields |
| playerContent | PASS |
| LocalProxy | PASS — proxy resources HTTP 200 |
| hls.js | PASS |
| Video dimensions | 1920 x 1080 |
| currentTime | 0.124580 -> 20.601173 seconds |
| Fatal media errors | 0 |
| Final player state | PLAYING |

No mock Spider, hard-coded media URL, fabricated Host result, or external phone
was used. The host-side clean command was correctly blocked by its development
machine preflight because `C:\Users\qiany\.android` exists; the PASS above is
from the isolated VMware Guest harness.
