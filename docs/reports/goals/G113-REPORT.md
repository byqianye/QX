# G113 Rust configuration history boundary

Status: complete for the Tauri configuration-catalog slice.

Dependency: G111 Rust business-data and configuration catalog boundary.

## Scope

- Keep the existing `backend_config_catalog` ingest contract unchanged.
- Add Rust-owned version history listing for a normalized source.
- Add Rust-owned activation of a previously stored configuration version.
- Make invalid or failed refreshes use the explicitly activated version.
- Do not modify `renderer/src`, remove Electron behavior, or touch `tmp/`.

## Acceptance

- Two valid versions can be stored and listed with one active version.
- Activating the older version changes the active hash.
- A later invalid ingest returns the activated version from the Rust cache.
- Missing versions fail with a stable `CONFIG_VERSION_NOT_FOUND` error.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml`
- `npm run check:rust`: 59 Rust core tests passed, 3 ignored; QuickJS sidecar 3 passed.
- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 118 files, 613 tests passed.
- `npm run audit:tauri:no-remnant`: passed.

## Remaining work

- This is one Rust migration slice; Electron/TypeScript business services remain intentionally preserved.
- Push, DLNA cast, and Android Runtime UI entry points still need separate Tauri/Rust Goals if they are required in the Tauri product boundary.
- Signed Releases, Authenticode evidence, and SignPath approval remain external G112 gates.
