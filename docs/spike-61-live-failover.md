# Spike 61: Live health and finite failover

Status: complete. Dependency: G60 Smart Channels.

## Decision

Live failover is a bounded runtime coordinator around the existing Live playback
session. It reacts only to explainable playback signals, keeps raw high-frequency
events in memory, and switches through a finite candidate list. It does not probe
third-party providers or claim that a stream is reachable before playback tests it.

The default mode is `Ask`. `Off` records health but never switches; `Ask` exposes
the next candidate for confirmation; `Auto` attempts candidates and reports the
attempt in the Live UI. The packaged fixture sets `Auto` only for deterministic
acceptance coverage; production defaults remain `Ask`.

## Health model

`LiveStreamHealthTracker` aggregates the following per-stream metrics:

- startup success and first-frame latency;
- playlist refresh failures and segment failures;
- buffer count and accumulated buffer duration;
- fatal player errors, disconnects, and uptime;
- last success/failure timestamps and consecutive failures.

User pause, seek, manual line selection, stop, and exit are recorded as neutral
events and do not increment failure metrics. A stream with no samples has an
`unknown` score. `calculateLiveHealthScore()` returns a bounded 0–100 score with
human-readable reasons, and never converts `unknown` into an unhealthy score.

Failover triggers are startup failure/timeout, repeated playlist failures, at
least two consecutive segment failures, fatal player error, backend disconnect,
and a continuous buffer of at least 8 seconds. One segment failure, a short
buffer, pause, seek, or manual line change alone cannot trigger a switch.

## Candidate order and loop safety

Ordinary channels use the channel's deterministic line order. Smart Channels use
the active member first, then the preferred/priority member order, and each
member's deterministic line order. Smart playback keeps the Smart Channel and
member identity while changing only the playback channel/line.

Every failover run owns a `tried` set, a maximum attempt count, a total deadline,
a generation number, and an `AbortController`. A candidate is added to `tried`
before it is attempted, so cycles such as A → B → A cannot repeat. A failed
stream enters a temporary circuit cooldown; expiry permits a later test and a
successful first frame clears the circuit.

Manual selection sets `manualOverrideUntil` for a short window and remembers the
line the user left. During that window the coordinator does not immediately
return to that rejected line. After expiry it becomes eligible again.

## Persistence boundary

Health events remain in bounded in-memory history. Dirty stream summaries are
debounced and written through `HealthRepository.upsertStreams()` in one SQLite
transaction. No segment event performs an individual database write. Existing
`stream_health` storage is reused, so the G61 change does not add a schema
migration.

## UI and EPG continuity

The Live panel shows mode, health summary, current/next candidate, trigger,
attempt count, cooldown, manual override, and score reasons. Ask exposes
approve/cancel/stay/return actions; Auto reports the same state while attempting.
The debug fields are derived from typed redacted UI state and never expose stream
URLs, cookies, authorization headers, or raw event details.

The playback selection callback updates the active Smart Channel member and
reuses the existing EPG timeline channel identity. A line/member failover does
not remap the current or next programme.

## Fixture and verification

The local media fixture includes:

- Source A / Channel A / Line A1: first frame succeeds, then segment failures;
- Source A / Channel A / Line A2: stable backup;
- Source B / Channel A: stable member backup;
- Source C / Channel A: startup failure.

Unit tests cover metrics, explainability, neutral user events, batching and
hydration, Off/Ask/Auto, attempt limits, circuit recovery, ordinary line
failover, single-segment protection, Ask stay, manual override expiry, and
restart hydration. Renderer tests cover the health/debug panel and actions.
Packaged first/restart E2E covers ordinary and Smart failover, startup failure,
EPG continuity, debug redaction, persistence, and process cleanup.

## Non-scope

G61 does not add IPTV protocol breadth, DRM or decryption, real provider
discovery, network probing, Android DEX compatibility, bundled mpv, or a claim
that all EPG mappings or all sources are automatically correct.
