# G105 Packaged UI E2E

## Current result

`PACKAGED_UI_FINAL_E2E = BLOCKED`

The packaged preview executable was rebuilt and smoke-tested locally. The VM runner was then executed against the real `csp_Jianpian` configuration with keyword `庆余年`, using the QX-only SDK, ADB server `tcp:5038`, and QX AVD `QXSpiderRuntime`.

The latest retained packaged failure was:

```text
ANDROID_PACKAGED_PLAYBACK_ERROR
Android Spider Host socket closed
```

The runtime log showed the QX Emulator reached `device`, boot completed, network validation passed, Host install/start began, and then the Emulator exited with code 1. A later cold-start retry failed earlier: the Emulator passed WHPX/system/disk checks, reached QEMU initialisation, and exited before an online ADB device appeared.

No packaged Search/Detail/Player/LocalProxy/HLS/20-second playback PASS is claimed for this latest run. The historical packaged report is not used as G105 final evidence because it predates the current source-local Runtime recovery fix and does not reproduce the current VM state.
