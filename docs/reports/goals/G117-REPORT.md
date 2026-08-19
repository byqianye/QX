# G117 signed-release workflow closure

Status: complete for the release-workflow closure slice.

Dependency: G112 release evidence collector, strict release gate, SignPath submission workflow, and the existing clean Win11 runner.

## Scope

- Add a fail-closed finalization command for the G112 report.
- Require verified clean Win11, upgrade, real HLS, signed component, and Authenticode evidence before generating a CI-only `Status: complete` report.
- Run that finalization only after SignPath output and clean Win11 verification, immediately before the strict G112 gate.
- Keep the source-tree G112 progress report blocked while the external signing evidence is absent.

## Acceptance

- Missing, malformed, unverified, or wrong-type evidence prevents report generation.
- The signed workflow invokes finalization after the signed installer clean-run and before `npm run verify:release`.
- The local repository remains fail-closed because no signature or component evidence is fabricated.

## Verification

- `npm test -- --run tests/g112-finalize-release.test.ts tests/tauri-component-manager-contract.test.ts tests/g112-release-gate.test.ts --reporter=dot`: 8 passed.
- `npm run typecheck`: passed.
- `npm run tauri:finalize-g112-release -- --evidence-dir artifacts ...`: correctly failed because signed component evidence is absent.

## Remaining work

- SignPath approval/project credentials, a real Authenticode signing result, and real signed component Releases are still external requirements.
- No package was signed, published, or pushed by this Goal.
