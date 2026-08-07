# Spike 59: EPG channel matching and programme timeline

## Goal status

- Status: complete; the G59 verification set and checkpoint commit passed.
- Dependency: G58 XMLTV EPG checkpoint `7628f96`.
- Scope: map stored live channels to stored XMLTV channels, expose explicit
  confirmation and suggestions, and show bounded current/next programme data.

## Matching policy

Matching is deterministic and evaluated in this order:

1. A user-confirmed explicit mapping.
2. Exact normalized `tvg-id` to XMLTV `channel.id`.
3. Exact normalized channel name.
4. A user alias or call sign.

`normalizeChannelName()` remains the shared normalization boundary: Unicode
NFKC, whitespace collapse, trim, and lowercase. It does not blindly remove
meaningful suffixes such as HD, FHD, 4K, +1, 高清, 超清, 少儿, or 国际.

Exact and high-confidence matches may be shown as mapped. Medium-confidence
alias matches are suggestions and require confirmation. Low-confidence and
ambiguous matches are never auto-selected. One XMLTV channel may serve several
live channels, but one live channel cannot silently select among conflicting
XMLTV candidates.

User-confirmed mappings are stored in SQLite and are not replaced by automatic
matching. A source refresh preserves a confirmed mapping when its referenced
XMLTV channel still exists; removed channels are not restored as invalid rows.

## Data and API boundary

Schema v7 adds `epg_channel_mappings` and `epg_channel_aliases`. The renderer
receives safe mapping metadata, candidates, confidence, current/next programme
fields, and a bounded timeline. URLs, stream headers, raw XML, and database
handles remain outside the renderer boundary.

The desktop API supports explicit set/confirm/clear, batch confirmation of
unique exact/high candidates, alias set/remove, and timeline set/clear. Playing
a live channel requests a default timeline window; the service caps any window
to 24 hours and 240 programme rows.

Current programme selection uses `startAt <= now < endAt`. Next programme
selection starts at the current programme end when a current programme exists,
which leaves gaps and overlapping rows deterministic. Programme progress is
computed from the programme time range and is separate from media playback
progress.

## Verification

The G59 verification set covers explicit mappings, persistence through restart
and source refresh, `tvg-id`, Unicode/name normalization, aliases, ambiguity,
confidence gating, shared XMLTV channels, current/next/no-programme states,
timeline bounds, renderer wiring, and packaged first/restart E2E.

```powershell
npm run typecheck
npx vitest run tests/epg-matching.test.ts tests/epg.test.ts tests/epg-ui.test.ts tests/live-playback.test.ts tests/live-playback-ui.test.ts tests/live-source.test.ts tests/live-ui.test.ts tests/sqlite-data-layer.test.ts tests/media-fixture.test.ts tests/vue-renderer.test.ts
npm test
npm run renderer:build
npm run electron:build
npm run electron:package:win
npm run electron:e2e:package
git diff --check
```

## Explicit non-scope

G59 does not build a large unverified alias database, scrape third-party live
sources, merge live channels into Smart Channels, implement failover, or claim
support for every XMLTV extension or Android DEX runtime.
