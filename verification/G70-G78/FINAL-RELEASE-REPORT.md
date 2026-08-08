# FINAL RELEASE REPORT

Final status: `release_candidate_ready` for the physical Windows local clean-room scope.

The local release-engineering work, user-authorized G73 self-review, physical Windows G76 clean-room matrix and G77 RC matrix are verified. This report does not claim a pristine OS image or stable production.

## Version and artifacts

- Version: `0.1.0` (not a public RC version).
- Installer: `dist/installer/QX影视-0.1.0-setup.exe`, 170781832 bytes.
- Installer SHA-256: `5582A22DE97136776AC984BBC6CB21751F3998B5D2E24B5AAFE053D2CAE15C5A`.
- Packaged brand ICO SHA-256: `5130C16B2771648B1F4AB27C261FAAD05842C28904C8DA24427C2A4438C1D580`.
- Portable: Windows unpacked package generated and first/restart E2E passed; no final portable ZIP is claimed.

## Gate matrix

- R70: passed; inherited E2E fixture was corrected through time-relative XMLTV/timeline behavior, and `liveFailoverEpgContinuity=true` in first/restart packaged E2E.
- G70: passed for local release scope; bundled Eclipse Temurin JRE 21.0.7+6 and CPython 3.12.10, manifest/executable hashes, no-system-JDK negative check and bundled Python smoke passed.
- G71: passed for local release scope; bundled mpv git 21277b0ccf and aria2 1.37.0 real smokes passed.
- G72: passed for local installer scope; NSIS is per-user, shortcuts were observed, and temporary install/launch/restart/backup/uninstall E2E passed.
- G73: `g73_self_review_passed`; OpenDesign artifact and handoff, independent light/dark preview, packaged first/restart visual matrix, ICO wiring, and temporary installed shortcut metadata were reviewed under the user's explicit self-review instruction.
- OpenDesign-open check: refreshed window-state capture failed with the exact owner-mismatch error; no visual sign-off is inferred.
- OpenDesign 0.18.1 MCP probe: stdio initialization and tool enumeration passed, but `get_active_context` returned `active:false` and an explicit project read returned `WORKSPACE_CONTEXT_REQUIRED`; this path remains unavailable, while G73 was accepted through the documented self-review path.
- G74: notices, CycloneDX SBOM (528 components), runtime manifest and build metadata generated.
- G75: automated audit reports 0 high/critical vulnerabilities, no hardcoded credentials, and runtime/process/RPC boundaries pass; clean-host and legal/signing review remain external.
- G76: `passed_local_windows_clean_room`; physical Windows temporary install path with Chinese directory, sanitized environment/PATH, real bundled runtimes, reinstall idempotency, default uninstall data retention and process/port cleanup passed. No pristine OS-image claim.
- G77: `RC_READY=true` for the local clean-room scope; full tests, packaged E2E, real bundled aria2 download path, runtime smokes, negative checks, performance probe, skip scan and cleanup passed.
- G78: `release_candidate_ready` for the local clean-room scope; no stable-production claim and no final portable ZIP claim.

## Verification

- Full suite: 73 files / 415 tests passed.
- Packaged first/restart E2E: passed, including backup, process cleanup, live failover continuity and restart checks.
- Final Setup E2E: passed on a temporary per-user install; this is not clean-machine evidence.
- Current installer E2E: passed with per-user install, desktop/Start Menu shortcuts, installed packaged first/restart/backup E2E, silent uninstall, and cleanup; installer SHA-256 is `5582A22DE97136776AC984BBC6CB21751F3998B5D2E24B5AAFE053D2CAE15C5A`.
- G76 local evidence: `verification/G76/G76-local-report.md` and `verification/G76/G76-local-report.json`; installed-package E2E used real bundled aria2 for its download step.
- G73 shortcut self-review evidence: `verification/G73/installer-icon-probe.txt`; both temporary shortcuts targeted the installed executable and used its embedded icon, then silent uninstall removed them.
- QEMU clean-guest attempt: ISO boot, setup recovery, 100% completion, and `G76 Test` desktop observed; guest-side product acceptance was not run because the host exhausted socket/memory resources, so no clean-guest acceptance is claimed.
- QEMU GTK-window retry: a visible guest window was exposed for UI automation but exited before stable interaction; it produced no additional acceptance evidence.
- Final persistent QEMU GTK retry kept the guest process alive, but refreshed window-state capture returned `node_repl exec context not found`; the exact QEMU process was stopped and no guest-side acceptance action was performed.
- TigerVNC 1.16.2 was installed and used for a normal QEMU VNC window; the same desktop-control error prevented state capture, so it produced no G76 evidence. QEMU and TigerVNC were stopped.
- A QEMU WinRM port-forward probe opened a TCP listener but `Test-WSMan` and bounded authenticated session attempts failed; no host-side unencrypted WinRM setting was changed, and no G76 evidence was produced.
- A one-shot clean-guest harness ISO was built and its packaged-E2E bundle passed on the host, but a fresh Windows guest stalled at Setup 77% before first logon; it produced no clean-Windows acceptance evidence.
- A second unattended retry was stopped at the user's direction at Setup 57% before first logon; its generated qcow2 disks, validation ISOs, installer output, and runtime-media staging directory were removed. It produced no additional clean-Windows acceptance evidence.
- `npm run typecheck`, full suite (73 files / 415 tests), renderer/Electron builds, packaged first/restart E2E, installer E2E, runtime smokes, `release:inventory`, `git diff --check` and secret-pattern scan passed.

## Git and open issues

- Current base checkpoint: `5015e0a4efc0e166317c716a1c6adf405abb9535`.
- G78 release commit is created locally after final validation; no push was performed.
- No stable production release is authorized.
