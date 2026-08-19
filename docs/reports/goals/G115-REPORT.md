# G115 Rust/Tauri DLNA cast boundary

Status: complete for the direct-media DLNA cast slice.

Dependency: G111 Rust business boundary and the existing Electron DLNA fixture contract.

## Scope

- Add a Rust `backend_cast` Tauri command with `snapshot`, `discover`, `play`, `stop`, and `disconnect` actions.
- Implement local-network SSDP discovery, MediaRenderer device-description parsing, AVTransport control URL validation, SOAP `SetAVTransportURI`/`Play`/`Stop`, and explicit session state.
- Route the existing renderer `/api/cast/*` actions through this command without changing cast UI components or visual behavior.
- Reject non-HTTP media, credential-bearing URLs, unsafe device descriptions, cross-origin control URLs, and custom media headers that still require the legacy bridge.

## Acceptance

- A local SSDP fixture is discovered and its AVTransport service is parsed.
- The Rust chain performs `SetAVTransportURI` → `Play` → `Stop` → `Disconnect` against a local HTTP/SOAP fixture.
- The Tauri renderer API no longer reports `/api/cast/discover` as `TAURI_RENDERER_ACTION_NOT_MIGRATED`.
- Invalid media and unsafe XML remain fail-closed.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml cast_core::tests::`: 4 passed.
- `npm run typecheck`: passed.
- `npm test -- --run tests/tauri-renderer-api.test.ts --reporter=dot`: 11 passed.

## Remaining work

- Header/subtitle media bridge behavior is intentionally not claimed as Rust-migrated; such sources fail with `DLNA_MEDIA_HEADERS_UNSUPPORTED` until a Rust cast bridge is implemented.
- Push and Android Runtime UI remain separate migration Goals.
- Signed Releases, Authenticode evidence, and SignPath approval remain external release gates.
