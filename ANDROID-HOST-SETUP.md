# Android Spider Host Setup

Status: **BLOCKED**

The Android Host is a standalone APK. Electron talks to it through ADB port forwarding and a loopback JSON-RPC socket.

## Environment

- Android SDK: PASS (`C:\Users\qiany\.workbuddy\android-toolchain\sdk`)
- ADB: PASS (`C:\Users\qiany\.workbuddy\android-toolchain\sdk\platform-tools\adb.exe`)
- Device: BLOCKED
- Host APK: PASS (`C:\Users\qiany\Documents\ChatGPT\QX影视\android-spider-host\app\build\outputs\apk\debug\app-debug.apk`)
- Host installed: BLOCKED
- Host RPC health: BLOCKED

## Commands

```text
npm run android-host:build
npm run android-host:check
npm run android-host:install
npm run android-host:start
npm run android-host:stop
```

The commands do not download Android system images automatically. Use an existing emulator or a connected Android 10+ device; x86_64 is preferred.

## Blockers

- `ANDROID_DEVICE_NOT_FOUND`
