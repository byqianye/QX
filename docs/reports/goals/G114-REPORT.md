# G114 Rust native download integrity

Status: complete for the Tauri native download service slice.

Dependency: G111 Rust desktop-service boundary.

## Scope

- Keep the existing `backend_desktop_services` download actions and payload contract unchanged.
- Write downloaded bytes to a unique `.part` file, flush them, and rename only after the complete body is available.
- Preserve replacement of an existing destination file and remove the temporary file on every write/rename failure.
- Bypass inherited HTTP proxies for loopback-only test/dev endpoints so the local canary reaches its local server.
- Do not modify `renderer/src`, remove Electron behavior, or touch `tmp/`.

## Acceptance

- A native HTTP download reaches `completed` with exact `totalBytes` and `completedBytes`.
- The downloaded file contains the exact response body.
- Replacing an existing file leaves the new file and no `.part` residue.
- Existing playback/credential URL rejection remains covered.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml`: passed.
- `npm run check:rust`: 61 Rust core tests passed, 3 ignored; QuickJS sidecar 3 passed.
- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 118 files, 613 tests passed.
- `npm run audit:tauri:no-remnant`: passed.

## Remaining work

- Push, DLNA cast, and Android Runtime UI entry points still need separate Tauri/Rust Goals if they are required in the Tauri product boundary; they are not silently marked migrated.
- Signed Releases, Authenticode evidence, and SignPath approval remain external G112 gates; no release artifact or signature report was fabricated.
