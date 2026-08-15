# G118 Rust/Tauri DLNA transport controls

Status: complete for the direct-media DLNA transport-control slice.

Dependency: G115 Rust/Tauri DLNA cast boundary.

## Scope

- Add Rust AVTransport `Pause`, `Play`/resume, `Seek`, `GetPositionInfo`, and `GetTransportInfo` actions.
- Route the existing `/api/cast/refresh`, `/api/cast/pause`, `/api/cast/resume`, `/api/cast/seek`, `/api/cast/position`, and `/api/cast/transport` paths through the Tauri RPC boundary.
- Keep the existing cast UI components and visual behavior unchanged.
- Parse bounded SOAP position/transport responses and update the Tauri cast session state.
- Do not claim custom media-header/subtitle bridge support; those remain an explicit G115 boundary.

## Acceptance

- A local SSDP/SOAP fixture completes discovery, direct playback, pause/resume, seek, position refresh, transport refresh, stop, and disconnect.
- Invalid seek values and devices without the requested AVTransport action fail closed.
- The renderer API routes all six control/refresh paths to Rust actions and no longer reports them as `TAURI_RENDERER_ACTION_NOT_MIGRATED`.
- `tmp/` is not read or modified by this Goal.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `cargo test --manifest-path src-tauri/Cargo.toml cast_core::tests::completes_local_ssdp_description_and_soap_playback_chain -- --nocapture`
- `npm run typecheck`
- `npm test -- --run tests/tauri-renderer-api.test.ts --reporter=dot`

## Remaining boundary

- Direct Rust cast still rejects media requiring request headers or the legacy subtitle/media bridge with `DLNA_MEDIA_HEADERS_UNSUPPORTED`; this is not silently downgraded.
- Android Runtime UI routes remain Electron-only until the emulator/supervisor is ported as a real Rust implementation; no Tauri placeholder was added.
