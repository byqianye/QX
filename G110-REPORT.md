# G110 playback and component progress report

Status: in progress
Dependency: G109 `1a8f291`

## Delivered

- Tauri `backend_playback_proxy` RPC with `start` and `close` lifecycle.
- Localhost-only proxy listener on a random port with per-session opaque token.
- HTTP(S) URL and request-header validation; credentials, hop-by-hop headers, and CR/LF injection are rejected.
- Loopback, localhost, private, link-local, unspecified, and multicast literal targets are rejected before proxy startup; session tokens include a random UUID component.
- GET/HEAD, Range request forwarding, bounded response size, content type, and media type classification for HLS/DASH/progressive sources.
- Playback proxy contract does not echo Cookie, Authorization, or other sensitive request headers.
- Rust component manager verifies Ed25519 detached manifests and SHA-256 artifacts, rejects wrong targets, stages before activation, retains one previous version, and supports atomic rollback/uninstall with a running-component switch guard.

## Verification

- `npm run typecheck`: PASS
- `npm run check:rust`: `cargo fmt --check`, `cargo check`, and 14 Rust tests PASS
- `npm run test:storage`: 5 files, 12 tests PASS
- Full regression after the security boundary update: 111 files, 559 tests PASS

## Not complete

HLS playlist/segment URI rewriting, AES-128, ClearKey, subtitles, quality switching, bounded multi-candidate failover, Shaka integration, WebView2 sniffing, mpv activation, and component download are not yet migrated to Tauri. The proxy currently buffers bounded upstream responses and does not claim full streaming-player compatibility. Component verification and local lifecycle are implemented, but no real signed Releases manifest is configured.
