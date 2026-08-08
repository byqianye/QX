# Android Spider Host Report

Status: **BLOCKED**

## Architecture

`QX Electron → AndroidSpiderBridgeClient → 127.0.0.1 JSON-RPC → ADB forward → Host APK → DexClassLoader → Spider JAR`

The Host binds only to Android loopback, receives artifacts through ADB, stores them under the application private files directory, and loads them with Android `DexClassLoader`. It does not use a JVM `URLClassLoader`, dex2jar, or Node `require`.

## Protocol v1

- Request: `{ id, protocolVersion, method, params }`
- Success: `{ id, protocolVersion, success: true, result }`
- Failure: `{ id, protocolVersion, success: false, error: { code, message, stage } }`
- Required methods: health, runtimeInfo, loadJar, unloadJar, createSpider, destroySpider, init, homeContent, homeVideoContent, categoryContent, searchContent, detailContent, playerContent, proxy, destroyAll

## Runtime evidence

- SDK / ADB / device: found / found / missing
- APK / installed / RPC: found / no / BLOCKED
- Artifact hash: not verified
- Class resolution: NOT_RUN
- Search / detail / player: NOT_RUN / NOT_RUN / NOT_RUN
