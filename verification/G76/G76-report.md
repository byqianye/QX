# G76 report

Status: `passed_local_windows_clean_room` (physical Windows scope; not pristine OS evidence).

The user-directed physical-Windows local clean-room matrix passed without using a virtual machine. Detailed current evidence is in `G76-local-report.md` and `G76-local-report.json`; the result is not promoted to a pristine OS-image claim.

A further QEMU 11.0.50 attempt used a fresh 64 GiB BIOS guest and the official Windows 11 Enterprise evaluation ISO. The ISO booted, unattended setup reached 77%, and a setup `ChildCompletion\setup.exe` recovery moved the guest through 95% and 100% to the `G76 Test` desktop. The guest-side installer, upgrade, uninstall, offline, and non-ASCII-path matrix could not be executed before the host exhausted socket/memory resources; no G76 clean-machine acceptance is claimed. This is retained as partial evidence of a local attempt, not as clean-Windows acceptance.

A subsequent low-memory GTK-window retry exposed a QEMU window to Windows UI automation, but the guest window exited before a stable interaction/smoke capture was obtained. This retry is also not acceptance evidence; the previously captured desktop remains the last positive clean-guest observation.

A final persistent GTK retry kept QEMU alive with the installed guest disk, but the UI automation layer returned `node_repl exec context not found` when reading the refreshed QEMU window state. The exact QEMU process was stopped after the failed capture; no installer or guest-side acceptance action was performed.

TigerVNC 1.16.2 was then installed from the winget package and used to expose the same QEMU guest as a normal VNC window. The desktop control layer still returned `node_repl exec context not found` while reading that returned TigerVNC window, so the viewer added no guest-side acceptance evidence. QEMU and the viewer were stopped after the attempt.

A separate QEMU boot with host port `5590` forwarded to guest WinRM confirmed only that QEMU opened a TCP listener. `Test-WSMan` and bounded Negotiate/NTLM session attempts did not establish a guest session; enabling host-side unencrypted WinRM was intentionally not performed. This produced no guest acceptance evidence and the exact QEMU process was stopped.

To remove the manual-window dependency, a one-shot validation harness was built into an attached ISO (`g76-validation-media.iso`, SHA-256 `F2C176C0EC8B6633188F245692FBE7FCEE057A5C4C500BC7765133B0228F922F`). It contains a 0.0.9 previous installer, the 0.1.0 installer, the bundled packaged-E2E runner, and a private Node executable that is not installed or added to the guest PATH. The bundled runner passed the complete first/restart fixture matrix on the host.

A fresh 64 GiB BIOS guest consumed the validation ISO and reached the Windows Setup `77% complete` screen, but remained there without reaching first logon or producing the guest report. The guest was stopped; therefore the harness remains an unexecuted plan and does not change the G76 status.

A second unattended retry was intentionally stopped at the user's direction while Windows Setup was at 57% (latest read-only screenshot). It never reached first logon and no guest acceptance was run. The retry's generated qcow2 disks, validation ISOs, installer output, and runtime-media staging directory were removed; the earlier installed guest disk and official Windows ISO were retained.
