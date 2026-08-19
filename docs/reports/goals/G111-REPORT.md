# G111 business data retention progress report

Status: complete
Dependency: G110 `a2f0dd3`

## Delivered

- Rust `business_records` table in the Tauri SQLite database with schema version `v1` behavior.
- Versioned `backend_business_data` RPC for `read` and `upsert` records.
- Restart-restorable records keep source id, history/favorite/live-style entity keys, and user business fields.
- Recursive sanitization removes token, Cookie, Authorization, temporary URL, and similarly named credential fields before persistence.
- Rust backup reads the sanitized business table only; the backup snapshot contains no credential or temporary-media fields.
- Rust business RPC now supports `read`, `upsert`, `list`, `remove`, `backup`, and `restore`.
- The Tauri renderer persists its view-state record through `backend_business_data`; the vertical slice test verifies the write uses the Rust RPC boundary.
- First feature-by-feature Rust migration slice is now connected: history/progress/pause/clear, favorites/groups, and follow/refresh/mark-watched are served by `backend_business_features` and restored into the Tauri renderer state.
- The feature boundary rejects media URLs used as history identities, validates favorite group moves and complete reorder sets, derives follow latest-episode metadata from episode lists, and supports selective history clearing.
- Download records require an opaque `requestReference` and reject BT, magnet, P2P, playlist, and playback URL forms; local-media and player-session records reject unsafe persisted paths/URLs.
- Rust desktop services now cover cache/storage, sanitized backup/restore, local media import/scan/play, native HTTP download state transitions, basic danmaku (JSON and XML), player fallback state, and detachable-player session state.
- Rust live/EPG services now cover M3U/TXT/XMLTV parsing, persistence, Smart Channel member management, and actual automatic Smart failover to the next enabled member.
- Rust Tauri now owns the VOD source-resolution orchestration and the renderer only submits the query and renders/selects the returned candidates. The Windows WebView2 sniffer boundary is also Rust-owned; it is isolated from persisted business records and uses a disposable profile.
- Rust business persistence now has a file-backed reopen test that confirms a record survives reopening its database and remains absent from a separate data root.
- The clean Win11 runner now performs three real packaged launches: first launch, same-data-root restart, and a separate-data-root launch. The latest evidence records all three exits as `0`, the same-root database present after restart, a distinct isolated database root, no new runtime processes after each phase, and clean NSIS uninstall.
- The interactive clean-runner launcher now records the child exit code and removes its exact outer workspace and isolated profile in a PowerShell `finally` block after the runner exits, so the launcher itself does not leave its owned test roots behind.
- The clean-runner now performs its own inner workspace deletion before writing evidence and records `observations.runnerWorkspaceRemoved`; cleanup failure changes verification to false and prevents the evidence file from being written.
- Existing Electron/TypeScript data repositories remain untouched and independent.

## Verification

- `npm run typecheck`: PASS
- `cargo fmt -- --check`, `cargo check --lib`: PASS; `cargo test --lib`: 58 passed, 3 ignored
- `cargo test --manifest-path src-tauri/Cargo.toml business_data::tests::reopens_business_database_and_keeps_data_roots_isolated -- --nocapture`: PASS (file-backed reopen and separate-root isolation)
- `npx vitest run tests/tauri-renderer-api.test.ts --reporter=dot`: 1 file, 5 tests PASS, including source, feature, live, EPG, and desktop-service routes
- `npm test`: PASS; 115 files, 583 tests
- `npm run test:storage`: 6 files, 14 tests PASS
- `npm run test:features`: 14 files, 74 tests PASS (legacy feature behavior/contract coverage)
- `npm run check:frontend`: typecheck and Vite build PASS
- Packaged UI smoke: PASS for config import, trust confirmation, Jianpian home/detail, and starting the Tauri playback proxy; the run used developer AppLocalData and is not clean-install evidence. The packaged WebView2 sniffer canary also passed against a real HTTPS HLS response and removed its disposable profile, but this is not clean-install evidence.
- `artifacts/tauri-clean-win11-e2e.json`: PASS on the interactive Windows 11 x64 host with isolated application roots, including first launch, same-root restart, separate-root isolation, WebView2 profile cleanup, NSIS uninstall, and no new runtime processes.
- `scripts/tauri-clean-win11-interactive-launcher.cs`: Roslyn compile check PASS after the outer-root cleanup change.

## Downstream constraints

The Rust business-service slices, file-backed reopen/isolation check, Rust-owned VOD source-resolution orchestration, and isolated interactive Win11 packaged restart/data-isolation evidence are complete for G111. Signed-release verification remains a G112 gate; disabled legacy features must remain disabled rather than deleted until G112.
