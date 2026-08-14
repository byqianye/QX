# G108 configuration, storage, and SourceCore progress report

Status: complete
Dependency: G107 `32ec107`

## Delivered

- Versioned Tauri `backend_config_catalog` RPC.
- Plain JSON, `tvbox://` Base64, `**` Base64, `2423` AES-128-CBC, and BOM handling with stable errors.
- SQLite schema v1 under Tauri `AppLocalData/qx-v1.sqlite3`.
- Up to three valid config versions per source, with fallback after a malformed refresh.
- Multi-repository ingestion with per-repository validation and aggregate site counts.
- Remote URL refresh through Rust with bounded timeout, no redirect following, an 8 MiB response limit, and last-good-cache fallback.
- Plain HTTP configuration responses expose `CONFIG_HTTP_UNAUTHENTICATED` as a non-secret warning.
- Renderer contracts for config ingestion, storage, and source-session requests.
- Rust `SourceSessionState` lifecycle: `open`, `call`, `cancel`, `close`, and `snapshot`.
- CMS HTTP type 0/1/4 boundary with URL/header validation, bounded timeout/cancellation, JSON/XML parsing, and stable backend error mapping.

## Verification

- `npm run typecheck`: PASS
- `npm run test:contracts`: 1 file, 4 tests PASS
- `npm run test:storage`: 6 files, 14 tests PASS
- `npm run check:rust`: `cargo fmt --check`, `cargo check`, 34 Rust library tests PASS, and 3 QuickJS sidecar unit tests PASS

## Completion boundary

G108 configuration, storage, SourceSession, and CMS boundary requirements are complete. Native Jianpian, restricted QuickJS, playback/component chains, and Rust business migration are tracked by the later G109–G111 reports; the legacy Electron/TypeScript implementations remain intentionally preserved until G112 authorizes final removal.
