# Android Spider Host

This is the standalone Android 10+ Host for the real Android DEX Spider PoC.
It binds the JSON-RPC server to `127.0.0.1:8765`; Windows reaches it only
through `adb forward`.

## Prerequisites

- Android SDK and ADB
- Android 10+ device or an existing emulator
- x86_64 is preferred for the PoC; ARM-only Spider native libraries are
  reported as `requires_arm64`

The build does not download SDK system images automatically.

## Build and run

From the repository root:

```text
npm run android-host:build
npm run android-host:install
npm run android-host:start
npm run android-host:check
npm run android-host:stop
```

The Host loads the pushed Spider artifact with Android `DexClassLoader` and
stores the verified copy under the app's private files directory. It is not a
Windows executable and does not use `dex2jar`, a JVM `ClassLoader`, or Node
`require` for DEX loading.
