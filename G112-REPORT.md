# G112 switch and release-gate progress report

Status: blocked by unfinished required gates
Dependency: G111 `1276fd7`

## Delivered

- The strict gate now resolves the actual `target/release/bundle/nsis` artifact and requires four external evidence files before formal release: clean Win11 E2E, 20-second HLS, signed component Releases, and Authenticode verification. Current RC release-path clean-install, upgrade, and 20-second HLS evidence are present and all bind to the same 5,136,805-byte installer (`c23c11a892a5d01312b3738d15110b6c728207f5b52a02b4e358522b6ea8d7c8`); `--allow-incomplete` remains the only development override while signed component Releases and Authenticode verification are missing.

- Added `npm run g112:release-gate` structural checks for Tauri identifier/NSIS target, G107–G111 reports, old Electron preservation during migration, Tauri backend presence, and the 20 MiB NSIS limit when an artifact exists.
- The gate now requires G108–G112 reports to explicitly say `Status: complete`; a `blocked` or `in progress` report cannot be bypassed by merely placing evidence files in `artifacts/`.
- The gate independently reads the measured NSIS installer with Windows `Get-AuthenticodeSignature` and compares the result with `tauri-signature.json`; a forged `Valid` field cannot pass the gate.
- Added `npm run tauri:component-manifest`, which accepts a signing-host Ed25519 private-key file and a multi-component staging spec, derives the public key, validates the Windows target/HTTPS URLs/artifact hashes, and writes only the detached manifest signature material needed by the release-evidence collector. It refuses non-Ed25519 keys, non-HTTPS URLs, and a public-key mismatch with `QX_COMPONENT_PUBLIC_KEY_BASE64`.
- The gate remains fail-closed when any required G107–G111 evidence or signed-release evidence is absent; it does not allow a false release-ready claim.
- Tauri still builds and canary-tests a real release QuickJS sidecar, but the optional binary is no longer embedded in the core NSIS resource list; release startup requires the verified `quickjs` component payload.
- `tests/g112-release-gate.test.ts` proves the default hard failure and the explicit development-only override.
- The latest fixture-anchor Windows x64 NSIS build passed at 5,134,187 bytes (4.90 MiB), SHA-256 `FA356C6381712FD4ACA7CF107BA064C9227AE8212027873E5E0543469E5FDA81`, below the 20 MiB structural limit; its 7-Zip listing contains only `qx-yingshi.exe` as the application binary and no QuickJS/mpv sidecar entry. The anchor is not a production signing key and this artifact is not Release evidence.
- Rebuilt after the current migration changes with `npm run build:windows:x64`; the NSIS target was produced successfully. The artifact is not a release approval without the remaining hard gates.
- `npm run test:feimao:canary` passed the real configuration fetch. The separate real Jianpian-to-HLS acceptance now passes through the packaged Tauri WebView2 player.
- The real Rust Jianpian search → detail → episode → player canary now passes; the packaged clean-runner install/restart/isolation acceptance is also present. G110's packaged quality, subtitle, and multi-candidate failover evidence is now recorded separately in `artifacts/tauri-g110-failover-e2e.json`.
- `npm test` passed 115 files / 587 tests, and the Tauri-boundary no-remnant audit passed.
- Repaired the G110 failover evidence record so `artifacts/tauri-g110-failover-e2e.json` is valid JSON and remains explicitly marked as real-media, fixture-catalog-only evidence.
- A real packaged UI smoke now passes config import, source trust confirmation, Jianpian home/detail rendering, and starting the Tauri playback proxy; it is recorded separately because it is not clean Win11 or HLS-20s evidence.
- `artifacts/tauri-hls-20s-e2e.json` records a real packaged Jianpian HLS run against `http://xn--z7x900a.net/`: first frame observed, playback advanced from 0 to 20.491 seconds, no mock source, and the evidence is bound to the current RC installer hash.
- `artifacts/tauri-clean-win11-e2e.json` now records a real interactive Win11 x64 per-user NSIS install/uninstall on host build 26200 using the current RC release installer: installer, Tauri/WebView2 launch, SQLite initialization, same-root restart with the database present, separate data-root launch, graceful exits, WebView2 profile removal, uninstaller, install-directory removal, and no new runtime processes after each phase all passed. The runner tracks Tauri, WebView2, QuickJS, mpv, Electron, Node, Java, Python, aria2, and Android/ADB process images; pre-existing developer Node processes are baseline-only and any new PID still fails the run. The runner uses isolated app/data roots and proves install/restart/data-root isolation and clean uninstall. The prior guest artifact is preserved as `artifacts/tauri-clean-win11-guest-e2e.json`.
- `artifacts/tauri-upgrade-win11-e2e.json` now records a real 0.8.0 → 0.9.0-rc.1 Tauri NSIS upgrade on isolated Win11 x64 data/install roots: the old package created the SQLite database, a user marker survived the in-place newer install, the new package relaunched successfully, uninstall removed the install directory, and no new tracked runtime process remained. The evidence carries the exact current RC installer hash and the runner workspace was removed before writing evidence.
- The release build now contains the Rust-owned WebView2 COM sniffer and renderer `parse != 0` routing; this is implementation evidence only and does not substitute for the missing clean-source playback evidence.
- Optional QuickJS/mpv payloads are no longer in the core NSIS resource list; QuickJS is a separate Cargo package and the rebuilt NSIS archive contains no sidecar entry. Release QuickJS startup is fail-closed until the signed component is installed.
- The packaged runtime canaries now pass real official mpv ZIP download/activation plus mpv named-pipe lifecycle and real WebView2 sniffer media discovery; both canaries remove their temporary runtime state and leave no new runtime processes. The mpv canary uses a temporary test trust anchor and is not production Release evidence.
- `Get-AuthenticodeSignature` reports the Tauri executable, QuickJS sidecar, and NSIS installer as unsigned; no trusted code-signing certificate is configured.
- The existing `artifacts/tauri-clean-win11-e2e.json` records a passing isolated Win11 run. A fresh rerun on this workstation now refuses at host preflight because the preserved user-data roots `com.qx.yingshi.desktop` and `QXMovie` are present; it does not write new clean evidence over that condition. The interactive launcher source now removes its exact outer workspace and isolated profile in a child-process `finally` block.
- A fresh isolated-root run now passes on the same interactive Win11 x64 host without touching the preserved user-data roots; the artifact records `runnerWorkspaceRemoved: true` and `runnerWorkspaceCleanupFailed: false`, and the exact outer test root was removed after the run.
- Aligned the Tauri config, Rust app package, and QuickJS sidecar package to the RC version `0.9.0-rc.1`; a new debug NSIS build now reports that version in both its filename and PE version resources. Existing unsigned evidence that refers to the former `0.9.0` package must be regenerated before a signed release gate can pass.
- `artifacts/tauri-clean-win11-rc-debug-e2e.json` records a fresh real Win11 x64 clean install/restart/data-isolation/uninstall run for the aligned RC package; it is development evidence only because the package is unsigned and is intentionally not substituted for signed Release evidence.
- Preserved the configured Jianpian `ext` endpoint when a user switches sources in the renderer; a fresh WebView2 canary with `http://xn--z7x900a.net/` selected `荐片`, searched `流浪地球`, used the Tauri playback proxy, and advanced real HLS playback to 20.465 seconds. The run is recorded as `artifacts/tauri-hls-20s-rc-debug-e2e.json` with the exact unsigned debug installer hash; it is development evidence only.
- Added a reproducible CDP/WebView2 canary entry point in `scripts/tauri-cdp-canary.ts` for source confirmation, source selection, real Jianpian search/detail, and optional 20-second playback verification.

## Not passed

- G107–G111 reports are complete for their implemented scope; G112 remains unfinished because signed component Releases and Authenticode proof are absent.
- No signed GitHub Releases component chain or Authenticode proof has been completed. The isolated fresh-user upgrade and post-upgrade uninstall now pass; the same-root restart, separate data-root isolation, and Tauri source-boundary no-remnant checks also pass.
- The current clean-install, upgrade, and HLS evidence all bind to the exact RC installer measured by the gate; they are still development evidence because that installer is unsigned.
- The development workstation still contains old application data at `C:\Users\qiany\AppData\Local\com.qx.yingshi.desktop` and `C:\Users\qiany\AppData\Local\QXMovie`; those old data roots were not deleted or moved because they may be user data and the migration requires manual rollback preservation. The current clean-runner evidence uses isolated roots on the interactive Win11 host.
- The default `npm run verify:release` remains expected to fail while the signed-release gates are incomplete; `--allow-incomplete` is development-only.
- Electron and old TypeScript backend remain intentionally preserved; deletion is not authorized until all prior gates pass.
- Authenticode signing is not configured; any future release would be RC-only until signing exists.
- A SignPath Foundation application was submitted for the public MIT-licensed repository on 2026-08-14. A mailbox search found no SignPath approval or project credentials as of the latest audit; the application itself is not release-signing evidence.

## Reproducible external gates

The repository now contains fail-closed runners for the remaining external proof classes. They do not create a passing artifact from a mock or from a developer machine:

```powershell
$env:QX_TAURI_CLEAN_E2E = "1"
$env:QX_TAURI_NSIS = "C:\path\to\QX-yingshi-setup.exe"
npm run tauri:e2e:clean-win11
```

For the isolated Tauri upgrade and post-upgrade uninstall audit, provide two real Tauri NSIS packages:

```powershell
$env:QX_TAURI_UPGRADE_E2E = "1"
$env:QX_TAURI_OLD_NSIS = "C:\path\to\QX影视_0.8.0_x64-setup.exe"
$env:QX_TAURI_NEW_NSIS = "C:\path\to\QX影视_0.9.0-rc.1_x64-setup.exe"
npm run tauri:e2e:upgrade-win11
```

Run the release-evidence collector on the signing host with the real component manifest, detached Ed25519 signature, public key, component bytes, and signed NSIS installer:

```powershell
# components-spec.json is kept outside the repository, for example:
# {"components":[{"id":"mpv","version":"<release>","artifact":"C:\\secure\\mpv.exe","url":"https://github.com/<owner>/<repo>/releases/download/<tag>/mpv.exe"}]}
npm run tauri:component-manifest -- `
  --private-key C:\secure\qx-components-ed25519.pkcs8 `
  --components C:\secure\components-spec.json `
  --output-dir C:\secure\qx-release-staging

npm run tauri:release-evidence -- `
  --installer C:\path\to\signed-setup.exe `
  --component-manifest C:\secure\qx-release-staging\components-v1.json `
  --component-signature C:\secure\qx-release-staging\components-v1.sig.b64 `
  --component-public-key C:\secure\qx-release-staging\components-v1.pub.b64 `
  --component-artifact C:\path\to\mpv.exe `
  --component-id mpv `
  --manifest-url https://github.com/<owner>/<repo>/releases/download/<tag>/components.json `
  --artifact-url https://github.com/<owner>/<repo>/releases/download/<tag>/mpv.exe
```

For an actual GitHub Releases download rather than pre-staged local files, use the network canary with the detached signature URL:

```powershell
npm run tauri:release-download-canary -- `
  --installer C:\path\to\signed-setup.exe `
  --manifest-url https://github.com/<owner>/<repo>/releases/download/<tag>/components.json `
  --signature-url https://github.com/<owner>/<repo>/releases/download/<tag>/components.sig.b64 `
  --artifact-url https://github.com/<owner>/<repo>/releases/download/<tag>/mpv.exe `
  --component-id mpv `
  --public-key-base64 <pinned-release-public-key-base64>
```

Only a successful clean Win11 run and a successful signed-release run write the evidence files consumed by `npm run g112:release-gate`. The clean runner also isolates and removes its WebView2 profile and checks for new runtime processes after launch, restart, isolated launch, and uninstall. Release component verification requires the manifest public key to match the compile-time `QX_COMPONENT_PUBLIC_KEY_BASE64` trust anchor; a Release binary built without that anchor rejects component activation. `src-tauri/build.rs` now refuses to produce such a Release binary at all. The existing clean-runner artifact is valid, but this workstation still cannot satisfy the external signed-component and Authenticode gates without real release artifacts and a code-signing certificate.
