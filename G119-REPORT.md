# G119 Rust/Tauri 弹幕播放同步

Status: complete for the danmaku synchronization slice.

Dependency: G111 Rust desktop-service boundary and G118 playback controls.

## Scope

- Expose the existing Rust `danmaku-sync` service through `/api/danmaku/sync`.
- Forward Tauri `/api/player/sync` progress payloads to both `player-sync` and `danmaku-sync`.
- Keep the existing renderer components and visual behavior unchanged.
- Document the new action in the backend API contract.
- Do not read or modify `tmp/`.

## Acceptance

- Direct danmaku synchronization updates Rust-backed `playing` and `currentTimeMs` state.
- Tauri player progress invokes `player-sync` followed by `danmaku-sync`.
- Renderer regression tests cover both routes.
- Existing Rust danmaku parsing/service tests remain passing.

## Verification

- `npm test -- --run tests/tauri-renderer-api.test.ts --reporter=dot` — 16 passed.
- `npm run typecheck` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml desktop_services::tests -- --nocapture` — 5 passed.
- `git diff --check` — passed.

## Remaining global gates

- Android Runtime still needs a complete Rust implementation of the emulator/ADB/Host bridge; no placeholder route was added.
- Signed component Releases, Authenticode proof, and clean signed Win11 E2E remain external release gates.
- Direct Rust cast still rejects media requiring custom request headers or the legacy subtitle/media bridge.
