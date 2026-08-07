# Spike 58: XMLTV EPG data layer

## Goal status

- Status: complete; checkpoint commit `checkpoint: complete G58 XMLTV EPG`
- Dependency: G57 checkpoint `c4a4828` (`checkpoint: complete G57 live playback`)
- Checkpoint: `checkpoint: complete G58 XMLTV EPG`

## Scope

G58 adds an explicit XMLTV source and programme data layer on top of the existing
live source/playback architecture:

- `EpgService` accepts `xmltv-url`, `xmltv-file`, and local `fixture` inputs.
- XMLTV is parsed incrementally with a SAX parser. Supported elements are
  `channel`, `display-name`, `icon`, `programme`, `title`, `sub-title`, `desc`,
  and `category`.
- XML security is part of the parser boundary: DTD and external entities are
  rejected, and compressed, decompressed, text, channel, programme, and request
  sizes are bounded.
- XMLTV timestamps are normalized to UTC before persistence. The explicit
  missing-timezone policy is to interpret a timestamp without an offset as UTC;
  this avoids silently using the machine's local timezone.
- SQLite schema v6 adds `epg_sources`, `epg_channels`, and `epg_programmes`.
  Programme window queries have channel/start, channel/end, and combined window
  indexes.
- Source content is written through prepared statements inside one transaction.
  Preview and staging do not mutate the database; apply replaces one source's
  channels and programmes atomically.
- The default retention window keeps six hours of past data and seven days of
  future data. Pruning removes expired rows while retaining the current and
  future programme window.
- URL refresh sends `ETag` and `Last-Modified`, handles `304 Not Modified`,
  preserves last-known-good rows on failure, and updates source error state.
- Settings exposes add URL/file, preview/apply, enable/disable, refresh, remove,
  last-success, programme count, and error state through the typed desktop API.

## Safety and persistence boundaries

Remote EPG URLs are limited to HTTP(S), same-origin redirects, and non-sensitive
query strings. Authorization headers, cookies, bearer tokens, API keys, and
password-like URL parameters are not accepted for persistence. The renderer sees
source metadata, counts, preview statistics, and sanitized errors; it does not
receive raw XML, request headers, or database handles.

The parser reports stable categories including `EPG_PARSE_FAILED`,
`EPG_SOURCE_FAILED`, `EPG_TOO_LARGE`, and `EPG_XML_UNSAFE`. Gzip input is bounded
both before and after decompression.

`currentProgramme` selects a programme containing the requested UTC instant.
`nextProgramme` starts at the current programme's end when a current programme
exists, otherwise at the requested instant. Overlapping programmes are ordered
by start/end/id, and G59 remains responsible for channel mapping and timeline UI.

## Verification

The G58 verification set covers valid Unicode/XMLTV fields, positive/negative and
missing offsets, malformed XML, DTD/XXE, programme/text limits, gzip limits, URL
and fixture loading, ETag/304, timeout and last-known-good behavior, batch writes,
indexes, retention, restart, UI API, renderer wiring, fixture validators, and
packaged first/restart import.

```powershell
npm run typecheck
npx vitest run tests/epg.test.ts tests/epg-ui.test.ts tests/live-playback.test.ts tests/live-playback-ui.test.ts tests/live-source.test.ts tests/live-ui.test.ts tests/sqlite-data-layer.test.ts tests/media-fixture.test.ts tests/vue-renderer.test.ts
npm test
npm run renderer:build
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
git diff --check
```

## Explicit non-scope

G58 does not automatically map every live channel, build an EPG timeline, merge
channels across sources, fail over streams, bypass DRM, discover third-party
sources, or claim compatibility with all IPTV formats or Android DEX.
