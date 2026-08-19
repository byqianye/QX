# G120 Rust 原生 Jianpian 真实链路 Canary

Status: complete for the native Jianpian network-canary slice.

Dependency: G109 native source boundary and G110 Tauri playback proxy.

## Scope

- Execute the Rust-native Jianpian chain against the live configured endpoint.
- Execute the same chain after three real refreshes of `http://xn--z7x900a.net/`.
- Verify initialization, search, detail, episode extraction, and direct HTTP playback resolution.
- Keep the existing renderer and Electron fallback untouched.
- Do not read or modify `tmp/`.

## Acceptance

- The direct endpoint canary returns a real search result, detail payload, episode URL, and `parse=0` HTTP playback result.
- The Feimao refresh canary completes three remote refreshes and then completes the same native Jianpian chain.
- No mock source, hard-coded response, or forced pass is used by either test.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml jianpian::tests::real_endpoint_completes_native_search_detail_and_player_chain -- --ignored --nocapture` — 1 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml config_catalog::tests::real_feimao_refreshes_three_times_and_completes_native_jianpian_chain -- --ignored --nocapture` — 1 passed.

## Remaining global gates

- Signed component Releases and Authenticode evidence are still absent; `npm run g112:release-gate` remains fail-closed.
- Clean Win11 evidence exists for unsigned RC artifacts, but signed-release E2E is not proven.
- Android Runtime remains a separate compatibility runtime and is not a Rust-only business implementation.
