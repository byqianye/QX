# G111 business data retention progress report

Status: in progress
Dependency: G110 `a2f0dd3`

## Delivered

- Rust `business_records` table in the Tauri SQLite database with schema version `v1` behavior.
- Versioned `backend_business_data` RPC for `read` and `upsert` records.
- Restart-restorable records keep source id, history/favorite/live-style entity keys, and user business fields.
- Recursive sanitization removes token, Cookie, Authorization, temporary URL, and similarly named credential fields before persistence.
- Rust backup reads the sanitized business table only; the backup snapshot contains no credential or temporary-media fields.
- Existing Electron/TypeScript data repositories remain untouched and independent.

## Verification

- `npm run typecheck`: PASS
- `npm run check:rust`: `cargo fmt --check`, `cargo check`, and 15 Rust tests PASS
- `npm run test:storage`: 6 files, 13 tests PASS

## Not complete

Full migration of live/EPG/smart channels/history/progress/favorites/follow/cache/local media/download/player flows is still open. The Rust backup snapshot is available, but archive restore, feature-specific repositories, and clean Win11 restart E2E have not yet been re-run against the Tauri backend. Disabled legacy features must remain disabled rather than deleted until G112.
