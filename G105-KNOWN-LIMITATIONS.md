# G105 Known Limitations

This file records limitations that are observed in the current environment. It is not a success waiver.

## Current verification blockers

- The QX-managed Windows guest has an unmounted `QXRuntime` NTFS partition with about 18 GB capacity. The existing C: partition is nearly full, so a clean system-image reinstall and AVD reprovision should use that isolated volume after it is mounted deliberately.
- The QX emulator process has previously exited during boot before the Host RPC became stable. Until a fresh isolated AVD reaches `ONLINE`, packaged Android playback remains `BLOCKED`.
- No final PASS is claimed for packaged Jianpian playback until real `videoWidth`, `videoHeight`, advancing `currentTime`, at least 20 seconds of playback, and zero fatal media errors are recorded.

## Source-level limitations

- The compatibility audit's `playback` field describes the real `playerContent`/PlayerContent result. It does not claim media playback; that gate belongs to the packaged UI E2E report.
- Authentication is only an automatic-source gate after a runtime-observed or persisted authentication result. A source name containing a storage-provider token is not treated as proof of authentication, because that would incorrectly suppress sources such as `csp_FeiMaoUC`.
- Third-party source outages, HTTP failures, and authentication requirements are reported per source and do not become an Android Runtime failure unless the Runtime or Host itself fails.

## Privacy

Reports redact query-bearing URLs and do not write cookies, tokens, account credentials, or resolved media URLs.
