# G78 verification

Status: `release_candidate_ready` (physical Windows local clean-room scope).

Gate summary:

- R70: local first/restart packaged E2E evidence present; no clean-worktree checkpoint or final release claim.
- G70: bundled JRE/Python packaging and missing-JRE negative check present.
- G71: bundled mpv/aria2 package and smoke evidence present.
- G72: per-user NSIS artifact and real temporary-directory installer E2E passed; G76 local clean-room install/reinstall/uninstall evidence is recorded separately.
- G73: `g73_self_review_passed`; static artifact, independent preview, packaged screenshot matrix, ICO wiring and installed shortcut metadata were reviewed under explicit user-authorized self-review.
- G74: notices, SBOM and runtime manifest material generated.
- G75: local security material generated; external clean-host validation remains open.
- G76: `passed_local_windows_clean_room`; no pristine OS-image claim.
- G77: `RC_READY=true` for the local clean-room scope.
- G78: `release_candidate_ready` for the local clean-room scope; no stable-production claim.

G78.6 user documentation is present under `docs/user/`, including installation, first start, config import, VOD, live TV, local media, downloads, casting, web console, backup/restore, troubleshooting, privacy/security and known limitations. G78.9 Setup smoke is covered by the real temporary-directory installer E2E, but it is not clean-machine evidence.

The local release-candidate record is ready; stable-production is not claimed.
