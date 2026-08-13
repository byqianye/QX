# G109 native sources and restricted runtime progress report

Status: in progress  
Dependency: G108 `73013c8`

## Delivered

- Explicit native-source registry for `csp_Douban` and `csp_Jianpian`; unknown `csp_*` values are not treated as universal compatibility.
- Rust-native `csp_Douban` metadata path using the endpoints documented by Spike 5–9: home, category, search fallback, and detail.
- Douban capability result explicitly sets `playback=false`; no playable URL is fabricated.
- `csp_Jianpian` reports `native_jianpian_port_pending` and maps calls to `SOURCE_RUNTIME_UNSUPPORTED` until a real native port or approved Android DEX runtime is available.
- Tauri SourceSession snapshots expose an optional availability reason for UI gating.
- `backend_runtime_capability` reports explicit runtime, capability flags, and unavailable reason codes for CMS, native, QuickJS, Python, DEX, and unknown inputs.

## Verification

- `npm run typecheck`: PASS
- `npm run check:rust`: `cargo fmt --check`, `cargo check`, and 12 Rust tests PASS
- `npm run test:storage`: 4 files, 11 tests PASS
- Native item mapping and source capability boundary are covered by Rust unit tests.

## Not complete

The QuickJS restricted sidecar is not yet packaged or invoked by the Tauri backend. Feimao cache/rollback, Jianpian full chain, PNG-disguised DEX recognition, and runtime installation/signature gates remain open. The old Electron/TypeScript runtime remains preserved.
