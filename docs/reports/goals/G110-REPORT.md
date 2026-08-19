# G110 playback and component progress report

Status: complete
Dependency: G109 `1a8f291`

## Delivered

- Tauri `backend_playback_proxy` RPC with `start` and `close` lifecycle.
- Localhost-only proxy listener on a random port with per-session opaque token.
- HTTP(S) URL and request-header validation; credentials, hop-by-hop headers, and CR/LF injection are rejected.
- Loopback, localhost, private, link-local, unspecified, and multicast literal targets are rejected before proxy startup; session tokens include a random UUID component.
- Upstream requests use a 30-second timeout, disable redirects, and re-check DNS-resolved addresses so hostnames resolving to private/local networks are rejected.
- GET/HEAD, Range request forwarding, bounded response size, content type, and media type classification for HLS/DASH/progressive sources.
- DASH SegmentTemplate variables such as $Number$ and $Time$ remain visible to the player while the static upstream prefix stays behind the opaque localhost route; the concrete suffix is revalidated and resolved by Rust.
- HLS playlist URI and URI-attribute rewriting, plus DASH `BaseURL`/media/initialization/sourceURL rewriting, keep playlist resources behind opaque localhost routes. Playlist-declared public cross-origin resources are allowed because real Jianpian manifests place signed MPEG-TS segments on a different host; each resource is still revalidated with HTTPS/credential/DNS-private-target checks.
- The localhost proxy responds with CORS headers and OPTIONS preflight support so HLS.js can request the dynamic proxy port from the Tauri WebView2 origin.
- The proxy normalizes generic upstream manifest MIME types (including `application/octet-stream` MPDs) to `application/dash+xml` or `application/vnd.apple.mpegurl` before returning rewritten manifests.
- The same manifest MIME normalization is applied to HEAD responses; Shaka's MIME probe therefore resolves opaque localhost DASH routes before parsing or initializing ClearKey.
- Manifest bodies remain bounded and are rewritten in memory; progressive media and non-manifest responses are now forwarded chunk-by-chunk with the same hard response limit instead of being fully buffered before the renderer receives them.
- The renderer includes Shaka Player 5.0.4 for DASH and DRM-configured sources; ClearKey maps to Shaka `drm.clearKeys`, while ordinary HLS remains on HLS.js. The Shaka code is dynamically loaded so the normal HLS path does not initialize it.
- ClearKey UUID-style KIDs and keys are normalized to Shaka's compact 32-hex form at the Tauri renderer boundary; the RPC contract test covers the mapping and license-server payload.
- The renderer exposes one quality selector for both engines: HLS.js switches `currentLevel` with an automatic `-1` mode, while Shaka toggles ABR and calls `selectVariantTrack` for a chosen variant. The selector is covered by the Vue renderer contract test.
- The renderer quality tests exercise both engine paths: HLS.js variant selection/automatic `-1`, and Shaka variant selection with ABR disable/restore.
- Tauri VOD fallback now owns a bounded three-attempt coordinator: it excludes the selected candidate, closes the old proxy/session, selects the next playable candidate, restarts playback, and stops when candidates are exhausted.
- Tauri native player responses now normalize `subtitles`, `subtitleTracks`, or `subtitle` into the renderer `PlayerSource`; the Tauri vertical-slice test verifies a default source subtitle reaches the player state.
- Tauri exposes a verified-component-only mpv bridge over Windows named-pipe JSON IPC; the renderer can select mpv for explicit `backend:"mpv"`/FLV playback and closes it with the proxy session.
- Tauri also exposes a detachable `player` WebviewWindow backed by the same Rust player session; attach/stop/close paths are wired and the child window uses the Tauri RPC directly.
- Tauri now includes a Windows-only WebView2 COM response sniffer with a disposable profile, exact HTTP(S) origin allowlist, safe request-header allowlist, navigation/resource/redirect caps, idle/total timeouts, and popup/download denial. `parse != 0` renderer player results enter this RPC and must return a scored media response before proxy startup.
- Optional QuickJS and mpv binaries are excluded from the core NSIS resources; both are expected under the verified component-manager store. QuickJS is built from a separate Cargo package, and the rebuilt NSIS archive contains no sidecar entry. The QuickJS bridge keeps a debug-only local fallback and fails closed in release builds when the signed component is absent.
- Last-session close and `PlaybackProxyState` drop abort the listener and clear its base URL.
- Playback proxy contract does not echo Cookie, Authorization, or other sensitive request headers.
- Rust component manager verifies Ed25519 detached manifests and SHA-256 artifacts, rejects wrong targets, stages before activation, retains one previous version, and supports atomic rollback/uninstall with a running-component switch guard.

## Verification

- `npm run typecheck`: PASS
- `npm run renderer:build`: PASS; Shaka is emitted as a separate renderer chunk
- `npx vitest run tests/vue-renderer.test.ts tests/tauri-renderer-api.test.ts --reporter=dot`: 2 files, 43 tests PASS
- `npm run check:rust`: `cargo fmt --check`, `cargo check`, 58 Rust library tests PASS, and 3 QuickJS sidecar unit tests PASS
- `npm run test:playback`: 3 files, 14 tests PASS
- `npm run test:components`: 1 file, 1 test PASS
- `npm run test:storage`: 6 files, 14 tests PASS
- `npm run check:frontend`: typecheck and Vite build PASS
- `npm run build:windows:x64`: PASS with a compile-time fixture anchor; latest unsigned x86_64 NSIS installer produced at 5,134,187 bytes (4.90 MiB), SHA-256 `FA356C6381712FD4ACA7CF107BA064C9227AE8212027873E5E0543469E5FDA81`, with no QuickJS/mpv sidecar entry in the archive listing
- `npm test`: PASS; 115 files, 583 tests
- `npm run audit:tauri:no-remnant`: PASS for the Tauri boundary; legacy Electron remains intentionally outside it
- `cargo test --manifest-path src-tauri/Cargo.toml real_jianpian_hls_proxy_fetches_cross_origin_segment -- --ignored --nocapture`: PASS; the Rust proxy fetched a real Jianpian manifest and a real cross-origin MPEG-TS segment.
- Packaged mpv component acceptance: PASS with the official mpv 0.41.0 Windows ZIP over HTTPS; Ed25519 manifest verification, SHA-256 download, ZIP payload/DLL activation, named-pipe start, command, close, and no-new-process cleanup all passed. Recorded in `artifacts/tauri-mpv-runtime-canary.json` using a temporary test trust anchor, not production Release evidence.
- Packaged Tauri UI HLS acceptance: PASS; real Jianpian search/detail 鈫?proxy 鈫?WebView2/HLS.js displayed a real first frame and advanced from 0:06 to 0:38 (38 seconds observed), recorded in `artifacts/tauri-hls-20s-e2e.json`.
- WebView2 sniffer unit coverage: PASS for HTTP-only URLs, exact origins, safe headers, media scoring, and HTML/image rejection.
- Packaged WebView2 sniffer acceptance: PASS against the real HTTPS HLS response `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`; candidateCount=1, media score=70, disposable profile removed, and no new runtime processes remained. Recorded in `artifacts/tauri-webview2-sniffer-runtime-canary.json`.
- Packaged Tauri UI non-DRM DASH acceptance: PASS; a real public Shaka MPD passed through the Rust proxy, $Number$ SegmentTemplate expansion remained intact, and WebView2 displayed a real first frame and advanced from 0:00 to 0:04 after a native video play gesture, recorded in `artifacts/tauri-dash-e2e.json`.
- Packaged Tauri UI ClearKey DASH acceptance: PASS; a real public ClearKey MPD passed through the Rust proxy, Shaka resolved the normalized manifest and 60-second duration, and after the native player gesture the media clock advanced from 0:00 to 0:05, recorded in `artifacts/tauri-clearkey-e2e.json`.
- Packaged Tauri UI quality acceptance: PASS; the real Angel One DASH manifest exposed multiple Shaka variants, and the packaged selector was changed to `576p · 992 kbps`.
- Packaged Tauri UI subtitle acceptance: PASS; the real manifest exposed Shaka text tracks (`fr`, `en`, and other language options), and the packaged subtitle selector was changed to `pt-br` with the subtitle toggle enabled.
- Packaged Tauri multi-candidate failover acceptance: PASS; the real failed MPD produced a visible `真实候选 · 第一集` prompt, approval switched the line to `真实候选`, the proxy remained `Tauri playback proxy`, and a native play gesture advanced the real DASH media clock to 0:11. Recorded in `artifacts/tauri-g110-failover-e2e.json`.
- Tauri renderer fallback acceptance: PASS; a failed first candidate prompts the alternate playable candidate, closes the first proxy, starts the alternate proxy, and ends in `stopped` after the bounded candidate list is exhausted.

## Downstream constraints

G110 is complete. The local packaged playback evidence still uses a temporary component trust anchor and an explicit native player gesture in this WebView2 environment; it does not substitute for G111 clean Win11 evidence or G112 production-signed Release evidence.

The runtime checks have packaged canary entry points. `npm run tauri:runtime-canary -- mpv` performs signed component download/activation and real mpv named-pipe start/command/close; `npm run tauri:runtime-canary -- sniffer` runs the Rust WebView2 sniffer against a real HTTPS parse page. Both current-host canaries pass and write evidence only after the packaged process exits and no new runtime processes remain; the mpv result still uses a temporary test trust anchor rather than production Release credentials.

The mpv canary requires these runtime inputs: `QX_TAURI_CANARY_COMPONENT_ID`, `QX_TAURI_CANARY_MANIFEST_JSON`, `QX_TAURI_CANARY_SIGNATURE_BASE64`, `QX_TAURI_CANARY_PUBLIC_KEY_BASE64`, and `QX_TAURI_CANARY_MEDIA_URL`. The Release executable must have been built with the same `QX_COMPONENT_PUBLIC_KEY_BASE64` trust anchor. The sniffer canary requires `QX_TAURI_CANARY_SNIFFER_URL` and optionally `QX_TAURI_CANARY_SNIFFER_ORIGINS`.
