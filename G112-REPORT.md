# G112 switch and release-gate progress report

Status: blocked by unfinished required gates
Dependency: G111 `1276fd7`

## Delivered

- Added `npm run g112:release-gate` structural checks for Tauri identifier/NSIS target, G107–G111 reports, old Electron preservation during migration, Tauri backend presence, and the 20 MiB NSIS limit when an artifact exists.
- The gate reports unfinished G108–G111 work instead of allowing a false release-ready claim.
- `tests/g112-release-gate.test.ts` proves the default hard failure and the explicit development-only override.

## Not passed

- G108–G111 reports still contain required unfinished items.
- No clean Win11 Tauri E2E, real Jianpian full chain, 20-second HLS acceptance, signed component chain, data-isolation upgrade test, or post-switch no-remnant audit has been completed.
- Electron and old TypeScript backend remain intentionally preserved; deletion is not authorized until all prior gates pass.
- Authenticode signing is not configured; any future release would be RC-only until signing exists.
