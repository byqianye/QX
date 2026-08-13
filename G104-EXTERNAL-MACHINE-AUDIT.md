# G104 External Machine Audit

Date: 2026-08-12  
RC: `0.9.0-rc.1`

## Status

```text
G104_EXTERNAL_MACHINE_ACCEPTANCE = PASS
```

The VMware Guest now has a qualifying clean packaged E2E. The official QX
Runtime, dedicated headless AVD, Android Host RPC, real `csp_Jianpian`
Search/Detail/PlayerContent, LocalProxy, and hls.js playback all passed. The
full current evidence is in `G104-EXTERNAL-MACHINE-REPORT.md`. Historical
preflight and earlier empty-source results below are retained for traceability.

## Supplied VMware candidate audit

| Check | Evidence | Result |
| --- | --- | --- |
| VMX | `D:\VMXXXXXXXXX\Win11\Windows 11 x64.vmx` | FOUND |
| VMware Workstation | `D:\VMware\vmware.exe` / `vmrun 1.17.0.25388281` | FOUND |
| Guest OS | Earlier ISO boot attempt logged `No Media`/`No operating system was found`; resumed VM now reports VMware Tools and HGFS sessions | SETUP/APP UNVERIFIED |
| Virtual disk | 32 GB NVMe descriptor, `Windows 11 x64.vmdk`; resumed guest has active Tools/HGFS | PRESENT, GUEST BOOT EVIDENCE |
| Windows ISO | `D:\VMXXXXXXXXX\Win11\zh-cn_windows_11_consumer_editions_version_24h2_updated_may_2026_x64_dvd_d061a709.iso` | PRESENT |
| ISO attached before correction | VMX had `sata0:1.deviceType = "cdrom-raw"`, `fileName = "auto detect"` | FAIL |
| Current offline correction | VMX now points to the supplied ISO with `cdrom-image` and `startConnected = "TRUE"` | CONFIGURED |
| ISO boot attempt | VMware log: `About to do EFI boot: EFI VMware Virtual SATA CDROM Drive` followed by `Status upon boot failure: Time out` and `OsNotFound` | FAIL |
| Resumed VM state | DHCP/ARP lease observed for VM MAC `00-0c-29-21-fb-1d` at `192.168.241.129`; VMware log shows disk I/O, sound initialization, VMware Tools `13.1.0.0.25218885`, and HGFS session start | WINDOWS GUEST TRANSPORT READY |
| External control channel | Guest TCP probes for SSH/RDP/WinRM/SMB were closed; `vmrun` guest queries remain blocked by VM encryption password | NOT AVAILABLE |
| RC transfer path | Temporary server bound to `192.168.241.1:8765` with only locked RC artifacts; no connection from `192.168.241.129` observed; scoped firewall rule creation returned `Access is denied` | BLOCKED |
| VMware shared-folder fallback | `E:\VM共享文件夹` enabled by user; host folder populated with Setup, Portable and SHA256SUMS only; both EXE hashes match the RC lock | HOST READY, GUEST VISIBILITY PENDING |
| VMware Tools / HGFS | VMware log reports VMware Tools `13.1.0.0.25218885` and `HGFS server session init complete and opened` | TRANSPORT READY |
| VM control | SSH key control is available as `ceshi\\qiany`; VMware RPC remains blocked by partial encryption; computer-use kernel fails before execution with OS error 3 | SSH READY, DESKTOP SESSION REQUIRED |

The VM reached the EFI CDROM boot path during an earlier attempt. In the resumed state, VMware Tools/HGFS is active and the RC artifacts are available through the configured shared folder. Direct guest copy/launch remains unverified because encrypted-VM RPC requires the VM password and the desktop control helper fails before execution. No QX acceptance result is inferred from this VM audit.

## Latest resumed-state verification (2026-08-11)

- The VM is running: `D:\VMXXXXXXXXX\Win11\Windows 11 x64.vmx`.
- The host shared folder contains only the locked Setup, Portable, and `SHA256SUMS.txt` artifacts.
- Setup SHA256 matches the RC lock: `15B1DDC971B3F7B5AA548DDC01CAB89DED59C063A23095DB8D7699E2B2E19E6E`.
- Portable SHA256 matches the RC lock: `A030E817457F9A311F922E7900DAE100CBB3B7676FB7B79B3A9B3AABCAFE0406`.
- VMware log confirms VMware Tools and an active HGFS server session.
- `vmrun` cannot copy into a Guest path or launch a Guest process because the VM is partially encrypted and requires its VM password.
- The desktop control kernel failed before execution with `系统找不到指定的路径。 (os error 3)`.
- Therefore the RC files are prepared for Guest access, but Setup launch, installation, and all subsequent G104 gates remain unverified.

## Latest Guest verification (2026-08-11, after SSH recovery)

- The Guest remains a clean QX machine: no QX process, install directory, desktop/start-menu shortcut, user data directory, or uninstall entry was found.
- The locked Setup process was started in Session 1, had no top-level window or child process, and was stopped after confirming that no installation had occurred.
- Retrying with a limited interactive task and with `explorer.exe` as the Shell launcher produced the same no-window process; both test tasks and the Setup process were cleaned up.
- The bundled Computer Use initialization was retried and failed before execution with `failed to write kernel assets: 系统找不到指定的路径。 (os error 3)`.
- This earlier setup-only snapshot was superseded by the later SSH-controlled
  Guest run below.

## Current host-side verification (2026-08-11)

| Command | Result | Evidence |
| --- | --- | --- |
| `npm test` | PASS | 100 test files, 525 tests |
| `npm run typecheck` | PASS | exit code 0 |
| `npm run build` | PASS | release build completed |
| `npm run android-host:build` | PASS | Gradle `BUILD SUCCESSFUL` |
| `npm run android-host:check` | BLOCKED | existing development emulator `emulator-5554` is `offline` |
| `npm run preview:smoke` | PASS | packaged preview smoke returned `status: PASS` |
| `npm run preview:android-clean-e2e` | BLOCKED | clean preflight found the development machine's `C:\Users\qiany\.android` and existing QX runtime |

## Qualifying clean Guest E2E (2026-08-12)

- Runtime root: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime`.
- Dedicated AVD: `QXSpiderRuntime`, serial `emulator-5554`, headless, WHPX ready.
- Host APK installed and RPC online.
- Real `csp_Jianpian` Search returned `20`; Detail succeeded for `2` matched
  candidates and exposed both play fields.
- Real PlayerContent, LocalProxy, and hls.js playback passed.
- Probe: `1920x1080`, currentTime `0.124580 -> 20.601173`, fatal errors `[]`.
- Guest PATH had no `adb` command. Existing `.android` existed, but the
  process environment pointed to the QX Runtime Android user home and QX ADB.
- No external phone was used; only the dedicated emulator was selected.

## RC artifact lock

| Artifact | Size | SHA256 | SHA256SUMS |
| --- | ---: | --- | --- |
| `release/rc/QX影视-RC-Setup-0.9.0-rc.1-x64.exe` | 185,643,976 | `15B1DDC971B3F7B5AA548DDC01CAB89DED59C063A23095DB8D7699E2B2E19E6E` | MATCH |
| `release/rc/QX影视-RC-Portable-0.9.0-rc.1-x64.exe` | 167,899,244 | `A030E817457F9A311F922E7900DAE100CBB3B7676FB7B79B3A9B3AABCAFE0406` | MATCH |

Runtime manifest: `build/android-runtime-manifest.json`  
Android Host manifest copy: `release/rc/win-unpacked/resources/android-host/android-runtime-manifest.json`

## Why the current machine is ineligible

The current machine has all of the following:

- project source at `C:\Users\qiany\Documents\ChatGPT\QX影视`
- `node_modules`
- existing QX user data under `%LOCALAPPDATA%\QXMovie`
- an existing QX Android Runtime
- an existing `%USERPROFILE%\.android`

It is therefore valid only for development-machine regression evidence, not for `EXTERNAL_MACHINE_RC_ACCEPTANCE`.

## Missing external evidence

The following gates have not been run on a qualifying external machine:

- machine preflight JSON/Markdown
- clean Setup installation and first launch
- no-runtime UI and Runtime Required flow
- user-confirmed Runtime Provision, License, download, verify, install, AVD, Host and RPC stages
- local MP4 preflight on the external machine
- manual playback confirmation
- Windows reboot recovery and warm Runtime playback
- Portable in an independent directory
- Setup/Portable conflict and Runtime lock behavior
- Upgrade, uninstall and reinstall gates
- crash recovery, log redaction, permissions, and non-ASCII path checks

The prior development-machine Clean E2E remains useful regression evidence, but it does not satisfy these external-machine gates.

## Required next input

The supplied VM is now the active external-machine candidate. The next required control-plane action is to make one Guest execution channel available (Remote SSH is preferred, or the encrypted-VM password for `vmrun`). Once that channel exists, run the fixed RC Setup from the shared folder and continue the G104 acceptance flow without installing Node, Android Studio, a system SDK, or system ADB.
