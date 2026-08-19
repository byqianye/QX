# G116 Rust/Tauri Push boundary

Status: complete for the loopback URL Push slice.

Dependency: G111 Rust business boundary, the existing Push UI contract, and the existing Tauri playback proxy.

## Scope

- Add a Rust `backend_push` command with `snapshot`, `refresh`, `settings`, `submit`, `confirm`, `reject`, `cancel`, and `clear` actions.
- Add a loopback-only HTTP listener at `127.0.0.1` with bounded JSON request parsing.
- Preserve confirmation, recent-record redaction, conflict mode, pending/queue state, and explicit fail-closed URL validation.
- Route existing renderer `/api/push/*` actions through Tauri without changing frontend visual components.
- Start the existing Rust playback proxy after a confirmed URL Push; do not expose the original URL directly to the player.

## Acceptance

- Only credential-free HTTP(S) URL Push is accepted.
- `source-item`, `local-file`, `live-channel`, `fixture`, file URLs, and custom request headers are rejected instead of being silently downgraded.
- HTTP Push returns a confirmation preview and does not place the full URL in recent records.
- Confirmed URL Push starts `backend_playback_proxy` and exposes its proxy URL through the existing player state.
- The Tauri renderer API no longer reports `/api/push/refresh` or `/api/push/confirm` as not migrated.
- No visual renderer component and no `tmp/` path was changed for this Goal.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml push_core::tests::`: 3 passed.
- `npm run typecheck`: passed.
- `npm test -- --run tests/tauri-renderer-api.test.ts --reporter=dot`: 13 passed.

## Remaining work

- Source-item/local-file/live-channel Push still needs a Rust-native resolver if those request types are required; this Goal intentionally does not pretend they work.
- Queue draining is state-only until a native player-stop event is connected to Push session lifecycle.
- LAN Push authentication remains disabled; the listener is loopback-only.
- Signed Releases, Authenticode evidence, clean Win11 E2E, and SignPath approval remain external release gates.
