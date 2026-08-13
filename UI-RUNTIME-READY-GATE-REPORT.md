# UI Runtime Ready Gate

## Goal

G101 continuation: the playback-source UI must wait for the shared Android Runtime before any Android DEX source initialization or search begins.

## Production path

`DesktopSpiderImportController.resolvePlaybackSources` calls the shared `SpiderRuntimeManager.prepareForSources(sites)`. The Electron main process supplies `AndroidRuntimeSupervisor.ensureReady()` to that manager. Only after the gate resolves does `PlaybackSourceResolver.resolve()` start its global timer and source workers.

The gate is single-flight at both layers:

- `SpiderRuntimeManager` caches support detection and coalesces concurrent preparation.
- `AndroidRuntimeSupervisor` coalesces provision, emulator boot, Host install/start, and RPC health.
- Runtime preparation has its own 90-second timeout and is outside the source-search global timeout.

## Real packaged UI evidence

Configuration: `fixtures/android-ui-real-config.json` (Douban metadata + real `csp_Jianpian` Android DEX source).

- Android Runtime READY marker: PASS
- Real Jianpian candidate visible in UI: PASS
- Search: PASS
- Detail: PASS
- `playerContent`: PASS
- LocalProxy: PASS
- hls.js: PASS (loaded and issued real proxy requests)
- Clean media probe: PASS (`1920x1080`, currentTime advanced from `0.185710` to `20.450266`, no fatal errors)
- Latest independent packaged retry: PASS (`1920x1080`, currentTime advanced beyond 20 seconds, no fatal errors)

## Automated verification

- Resolver gate ordering regression: PASS
- Runtime preparation single-flight regression: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS (100 files, 525 tests)
- Packaged UI Android E2E: PASS on the latest real-media probe
- Clean Windows Android E2E: PASS; Runtime/Host/Search/Detail/PlayerContent/LocalProxy/hls.js/playback all passed

The Clean E2E child process cleared/overrode Android environment variables. Its audit reported `cleanMachine=true`, `systemAdbParticipated=false`, `existingAndroidUserDirUsed=false`, and `androidStudioUsed=false`; only the QX-managed `emulator-5554` participated.
