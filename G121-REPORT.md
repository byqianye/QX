# G121 Tauri QuickJS sidecar 真实生命周期

Status: complete for the QuickJS sidecar build and lifecycle slice.

Dependency: G109 restricted QuickJS boundary and G112 component-release workflow.

## Scope

- Build the Rust QuickJS sidecar in debug and release profiles.
- Run the real sidecar process through JSON-RPC `load`, module import, `call`, capability reporting, timeout enforcement, and `close`.
- Verify the process exits with code 0 after close.
- Keep the sidecar optional and outside the core NSIS resource list.
- Do not read or modify `tmp/`.

## Acceptance

- Debug and release binaries both pass the same real-process canary.
- Module loading and restricted capabilities work; an infinite loop is stopped with `QUICKJS_TIMEOUT`.
- The sidecar closes cleanly and leaves no live child process owned by the canary.

## Verification

- `npm run tauri:prepare-sidecar:dev` — passed.
- `npm run test:quickjs:sidecar` — `QuickJS sidecar canary passed (debug)`.
- `npm run tauri:prepare-sidecar --release` — passed.
- `npm run test:quickjs:sidecar -- --release` — `QuickJS sidecar canary passed (release)`.

## Remaining global gates

- The component binary still needs a real signed GitHub Release and detached manifest signature before release evidence can pass.
- Authenticode and signed clean Win11 E2E remain external gates.
