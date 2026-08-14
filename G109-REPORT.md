# G109 native sources and restricted runtime progress report

Status: complete
Dependency: G108 `73013c8`

## Delivered

- Explicit native-source registry for `csp_Douban` and `csp_Jianpian`; unknown `csp_*` values are not treated as universal compatibility.
- Rust-native `csp_Douban` metadata path using the endpoints documented by Spike 5–9: home, category, search fallback, and detail.
- Douban capability result explicitly sets `playback=false`; no playable URL is fabricated.
- `csp_Jianpian` is now a Rust-native adapter. It requires the configured HTTP(S) `ext`, implements init/home/category/search/detail/player, and rejects FTP/non-HTTP playback candidates instead of silently delegating to Android DEX.
- A real Jianpian canary completed search → detail → episode → player against the configured endpoint; the canary is ignored by default and must be run explicitly for network verification.
- The Rust QuickJS sidecar is implemented as a bounded NDJSON process with ESM module loading, origin allowlisting, request/response limits, memory/stack limits, interrupt deadlines, and explicit close lifecycle.
- Release component verification now compares the submitted Ed25519 public key with the compile-time `QX_COMPONENT_PUBLIC_KEY_BASE64` trust anchor; a Release build without that anchor rejects component activation.
- The Tauri renderer now probes QuickJS capabilities, loads inline or allowlisted HTTP(S) script references through the Rust bridge, and routes init/home/category/search/detail/player calls to the sidecar without the legacy `/api/*` server.
- Tauri now exposes `backend_quickjs_sidecar`, keeps one process per session, terminates replaced/closed/dropped sessions, and resolves the release sidecar from the verified `quickjs` component-manager payload. Only debug builds retain a local development fallback. The sidecar is built from a separate Cargo package so Tauri's core bundle cannot auto-collect it as a second binary.
- Tauri SourceSession snapshots expose an optional availability reason for UI gating.
- The Tauri renderer now consumes Rust catalog site summaries and drives import, source-session open/call, native browse/detail, and player requests without falling back to the legacy `/api/*` HTTP server.
- Tauri now implements `/api/playback-sources/search` and `/api/playback-sources/select` with a Rust-owned resolver RPC. Per-site search, detail, playback-catalog parsing, candidate scoring, diagnostics, temporary SourceSession lifecycle, and QuickJS isolation now execute in Rust; the renderer only submits state and renders/selects the result.
- Tauri `/api/switch` and `/api/close` now close/reopen the real Rust source session instead of leaving the legacy server lifecycle active.
- `backend_runtime_capability` reports explicit runtime, capability flags, and unavailable reason codes for CMS, native, QuickJS, Python, DEX, and unknown inputs.
- Feimao configuration canary is a real network check with no mock or forced success; the latest run parsed 39 sites (38 Java, 1 QuickJS).
- Rust now has an ignored real-network Feimao canary that refreshes the remote catalog three times, reads the configured `csp_Jianpian` endpoint, and completes native `init → search → detail → player` from that refreshed catalog.
- PNG-disguised DEX recognition is informational only and does not execute, load, install, persist, or publish the artifact.

## Verification

- `npm run typecheck`: PASS
- `cargo fmt -- --check`, `cargo check --lib`: PASS; `cargo test --lib`: 58 passed, 3 ignored; release sidecar canary PASS.
- `npm run test:storage`: 6 files, 14 tests PASS
- `npm run test:sources`: 4 files, 25 tests PASS
- `npm run test:quickjs`: 2 files, 8 tests PASS
- `npm run tauri:prepare-sidecar:dev`: PASS (debug sidecar build)
- `npm run test:quickjs:sidecar`: PASS (debug protocol canary, including ESM module and timeout)
- `npm run test:quickjs:sidecar -- --release`: PASS (release protocol canary, including capability probing and clean sidecar exit)
- `npm run tauri:prepare-sidecar`: PASS (optimized Windows sidecar build)
- `npm run tauri:build`: PASS; optional QuickJS/mpv payloads are excluded from the core NSIS resources, and the NSIS archive contains only `qx-yingshi.exe` as the application binary. This is an unsigned build artifact, not a signed Release.
- `npm run test:feimao:canary`: PASS (real remote configuration; not a Jianpian playback canary)
- `cargo test --manifest-path src-tauri/Cargo.toml config_catalog::tests::real_feimao_refreshes_three_times_and_completes_native_jianpian_chain -- --ignored --nocapture`: PASS (three real Feimao refreshes plus native Jianpian init/search/detail/player; isolated system-temp SQLite cache)
- `cargo test --manifest-path src-tauri/Cargo.toml jianpian::tests::real_endpoint_completes_native_search_detail_and_player_chain -- --ignored --nocapture`: PASS (real network search → detail → episode → player canary)
- `npx vitest run tests/tauri-renderer-api.test.ts`: PASS (5 tests, including the Rust-owned resolver RPC boundary, playback-source search/select, and source close)
- `npm test`: PASS (115 files, 583 tests)
- `npm run tauri:build`: PASS with a compile-time fixture anchor; latest NSIS artifact 5,131,144 bytes (4.89 MiB); SHA-256 `0536E6BE306595BEF10EC5A8D0D26D8688A329CE524A79B52B208A6ACA1EB628`; 7-Zip archive listing contains no QuickJS/mpv sidecar entry. This is not a signed Release artifact.
- Native item mapping and source capability boundary are covered by Rust unit tests.
- Packaged UI smoke: PASS for config import, trust confirmation, Jianpian home/detail, and starting the Tauri playback proxy; recorded in `artifacts/tauri-packaged-import-smoke.json`.
- Clean interactive Win11 x64 packaging evidence: PASS for the real per-user NSIS install, first launch, same-root restart, isolated data-root launch, graceful exits, and uninstall; recorded in `artifacts/tauri-clean-win11-e2e.json`.

## Downstream constraints

The sidecar, native Jianpian source path, Rust-owned VOD resolver, Feimao-derived three-refresh/native Jianpian canary, and packaged Win11 install/restart/isolation path are implemented and verified for G109. Release QuickJS startup still fails closed until a signed component is installed and its public key matches the build trust anchor. The resolver deliberately skips QuickJS sites during cross-site resolution because their session must remain sidecar-owned. The existing TypeScript QuickJS/runtime backends remain preserved until the later migration gates authorize removal.
