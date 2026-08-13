# G108 configuration, storage, and SourceCore progress report

Status: in progress
Dependency: G107 `32ec107`

## Delivered

- Versioned Tauri `backend_config_catalog` RPC.
- Plain JSON, `tvbox://` Base64, `**` Base64, `2423` AES-128-CBC, and BOM handling with stable errors.
- SQLite schema v1 under Tauri `AppLocalData/qx-v1.sqlite3`.
- Up to three valid config versions per source, with fallback after a malformed refresh.
- Renderer contracts for config ingestion, storage, and source-session requests.
- Rust `SourceSessionState` lifecycle: `open`, `call`, `cancel`, `close`, and `snapshot`.
- CMS HTTP type 0/1/4 boundary with URL/header validation, bounded timeout/cancellation, JSON/XML parsing, and stable backend error mapping.

## Verification

- `npm run typecheck`: PASS
- `npm run test:storage`: 3 files, 10 tests PASS
- `npm run check:rust`: `cargo fmt --check`, `cargo check`, and 8 Rust tests PASS

## Not complete

Multi-repository ingestion, unauthenticated HTTP warning, native Douban/Jianpian, restricted QuickJS, and playback/component chains remain in G109/G110. Existing Electron/TypeScript implementations remain in place until the later migration gates.
