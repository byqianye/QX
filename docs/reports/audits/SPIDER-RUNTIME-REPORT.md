# Spider Runtime V1 Report

## Delivered

- Unified `SpiderRuntime` contract and `SpiderRuntimeManager`.
- Runtime detection for CMS, Native, JavaScript, Android DEX, Python, and unsupported sites.
- Native registry with built-in registration points for `csp_Douban` and the JVM playable fixture. Registration is capability routing; no fake third-party playback is created.
- Static `JarInspector`. It reads ZIP/JAR central-directory metadata only and reports DEX/classes/native libraries/assets and runtime requirement.
- `SpiderArtifactCache` with URL + declared MD5 + actual SHA-256 identity, size limit, timeout, hash verification, metadata validators, and atomic writes.
- Android DEX state via `AndroidJarRuntime`; missing Android execution is reported as `android_dex_runtime_not_available`.
- JavaScript Worker Runtime using `worker_threads`, QuickJS sandboxing, execution/memory/response limits, timeout termination, crash isolation, and deterministic destroy.
- QuickJS sandbox bridge for request/fetch/post, console, Base64 encode/decode, hash, and in-memory local storage. Guest code cannot access Node `process`, `fs`, `require`, child processes, or Electron IPC.
- Resolver integration that requires only runtime support plus `search` and `detail` capabilities. Playback capability is not a search prerequisite.
- Runtime fields and specific diagnostic reasons in playback-source diagnostics.
- Real configuration audit in [RUNTIME-AUDIT.md](RUNTIME-AUDIT.md).

## Runtime support boundary

Supported by implementation seams:

- CMS HTTP type 0/1/4.
- Registered Native adapters, including the existing Douban registration point.
- JavaScript Worker Runtime.
- Python sidecar when the configured Python executable is available.

Explicitly unsupported in this desktop build:

- Android DEX without an Android adapter: `android_dex_runtime_not_available`.
- Invalid/corrupted containers: `invalid_jar`.
- Failed downloads: `jar_download_failed`.
- Declared hash mismatch: `jar_hash_mismatch`.
- Missing Python executable: `python_runtime_missing`.
- Missing/unsupported site binding: `unsupported_site_type`.

No Android emulator, WSA, DEX-to-JAR converter, or unknown executable was introduced.

## Verification recorded so far

- `npm test -- --run tests/spider-runtime.test.ts tests/js-spider-worker.test.ts tests/spider-import.test.ts`: passed during implementation.
- `npm test -- --run tests/quickjs-engine.test.ts tests/spider-runtime.test.ts tests/js-spider-worker.test.ts tests/playback-source-resolver.test.ts tests/spider-import.test.ts`: passed during implementation.
- `npm run typecheck`: passed.
- Real configuration acceptance: 39 sites, 33 searchable; 37 Android DEX, 1 Native, 1 JavaScript; all 33 searchable sites require Android DEX and are therefore currently unsupported by the desktop runtime.
- `npm test`: passed, 80 files and 455 tests.
- `npm run electron:e2e:package`: passed, including sidecar PID exit checks after the Native Runtime integration.

Full-suite, renderer build, Electron build, and packaged E2E verification all passed. See [the test log](SPIDER-RUNTIME-TEST-LOG.md).
