# Spike 62: Danmaku receive, timeline, and player overlay

Status: complete. Dependency: G61 checkpoint `c1efa26`.

## Decision

G62 adds a read-only danmaku path around the existing player. The application
accepts user-provided JSON/XML, local JSON/XML selected in the renderer, an
explicit source adapter, or a controlled fixture. It parses and displays
comments but never discovers, scrapes, or sends comments to a third-party
platform. The live timeline accepts preloaded local/fixture items; a real-time
third-party danmaku provider is outside this Goal.

The implementation keeps the existing Neutral Modern player and Settings
surface. `DanmakuService` owns parsing, filtering, timeline state, and the
existing SQLite `settings` repository key `player.danmaku.settings`; no schema
migration is needed beyond the current schema version 8.

## Model and adapter boundary

`DanmakuItem` contains a stable id, millisecond timestamp, text, one of
`scroll`, `top`, `bottom`, or `reverse`, optional safe color/font size, and a
source identifier. Unsupported type values are normalized to `scroll` while
retaining bounded `rawType` metadata, so an unfamiliar fixture does not crash
the player.

`DanmakuSourceAdapter` exposes only `load`, `query`, `cancel`, `clear`, and
`destroy`. The current local adapter handles project JSON, XML fixtures, item
arrays, and the adapter output. The player core does not understand a
third-party protocol. Payloads are capped at 8 MiB and 100,000 normalized
items; text is capped at 500 characters.

## Timeline

`DanmakuTimeline` is driven by the media `currentTime` in milliseconds. It
tracks playing/paused state, playback rate, a generation, and the current
window. Play, pause, resume, forward seek, backward seek, speed changes, and
episode changes are covered. A seek or large time discontinuity increments the
generation; loading another episode resets the timeline. Rendering queries
only the bounded current window, so a seek never replays every historical
item.

Player and live sync requests remain typed media sync requests. The main
process converts seconds to milliseconds and updates danmaku state without
returning raw playback headers or raw source payloads to the renderer.

## Overlay and collision policy

`DanmakuOverlay` is a separate layer above `<video>` inside the existing
player stage. It uses text nodes (`v-text`), not HTML injection, and renders
scroll, top, bottom, and reverse items. Opacity, font size, speed, density, and
display area are settings-driven. A deterministic track allocator keeps
scrolling items from sharing one y-coordinate whenever a track is available.

The render path enforces `maxActive`, `maxPerSecond`, and `trackCount`. Filtering
evaluates only a bounded prefix and density uses a stable id sample. The UI
state exposes at most 5,000 items and the overlay creates at most
`maxActive` DOM nodes; the 1,000, 10,000, and 50,000 item fixtures therefore do
not become 50,000 DOM nodes.

## Safety and filtering

Input text is control-character cleaned and tag-stripped before it reaches the
typed UI state. The overlay uses `v-text`; it does not use `v-html`, execute
Markdown HTML, create images/SVG/script nodes, or place user values in CSS
except after numeric/color validation. XML rejects `DOCTYPE`, `ENTITY`,
`script`, `style`, and `svg` content. `userHash` is removed from the public UI
item.

Local filtering supports keyword, type, source, and an optional bounded
case-insensitive regex. Regex length is capped at 128 characters, obvious
nested/repeated high-risk structures are rejected, and execution is scoped to
the bounded text/query set.

## Settings and UI

The Settings page adds one existing-style `SettingsSection` for the danmaku
toggle, opacity, font size, speed, density, display area, type/source filters,
keyword/regex filters, local JSON/XML selection, and clear. Settings writes go
through the existing `SettingsRepository`; the renderer emits typed intents and
does not access SQLite, network clients, or filesystem paths directly.

## Verification

The focused tests cover model normalization, JSON/XML parsing, unsafe XML,
HTML escaping, timeline transitions, all four render types, filtering and
regex limits, 1,000/10,000/50,000 item parse/render bounds, adapter lifecycle,
SQLite restart hydration, VOD/live fixtures, the Vue overlay/settings panel,
and packaged E2E load/sync checks. Full results are recorded under
`verification/G62/`.

## Non-scope

G62 does not add Android DEX compatibility, DRM/payment/account/region bypass,
unknown media sources, automatic third-party danmaku discovery, third-party
danmaku sending, or an internet-facing control surface.
