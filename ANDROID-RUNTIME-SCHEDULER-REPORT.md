# Android Runtime Scheduler

## Search scheduling contract

- Runtime preparation is outside the playback-source global search timer.
- Search workers are capped at four.
- Runtime/JAR initialization is capped at two concurrent operations.
- Each source keeps its own 15-second operation budget.
- The default global source-search budget is 45 seconds.
- When the global budget stops scheduling new sites, already-started workers finish their bounded operation and their candidates are retained.

## Reuse

`SpiderRuntimeManager` caches support detection and runtime instances by site key/API/ext. The Android artifact registry and Android bridge are shared from the Electron main process; the UI does not create a second Android runtime for source search.

## Verification

- Separate initialization concurrency: PASS
- Candidate preservation after global stop: PASS
- Android prepare single-flight: PASS
- Native-only source does not start Android runtime: PASS
- `npm test`: PASS (98 files, 514 tests)
- `npm run typecheck`: PASS
- `npm run build`: PASS
- Android Host build using QX SDK: PASS
- Android Host check using QX SDK: PASS
- Packaged playback and Clean Windows Android E2E: PASS

## Runtime used by the final E2E

- Runtime root: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime`
- SDK: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\sdk`
- AVD home: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\avd`
- Android user home: `C:\Users\qiany\AppData\Local\QXMovie\android-runtime\state\android-user`
- Serial: `emulator-5554`
- External phone: not used
