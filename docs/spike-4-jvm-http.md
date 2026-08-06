# Spike 4: Real JVM-native HTTP Spider

## Contract

The temporary Map contract is replaced with the JVM equivalent of the CatVod Spider seam:

```java
void init(String ext) throws Exception;
String homeContent(boolean filter) throws Exception;
void destroy() throws Exception;
```

Android `Context` is intentionally omitted. The existing `home` NDJSON method maps to `homeContent(boolean)`. The Host parses the JSON string returned by `homeContent` before sending the NDJSON response, so callers receive a JSON object/array rather than a quoted JSON string.

## Real HTTP Spider

`fixtures/jvm/HttpSpider.java` uses only JDK 21 APIs:

- `java.net.http.HttpClient` performs the GET request.
- `init(ext)` treats `ext` as an HTTP/HTTPS endpoint.
- `homeContent(filter)` adds the filter query parameter and returns the UTF-8 response body.
- non-2xx responses fail the RPC request; sidecar timeouts still terminate the process.

The integration test uses an ephemeral local HTTP server so the request, JSON body, and delayed timeout are deterministic. `npm run spike:jvm` additionally uses the public TVMaze endpoint `https://api.tvmaze.com/search/shows?q=girls` by default. TVMaze documents this as a free JSON REST API: https://www.tvmaze.com/api.

## Verification

```powershell
npm test
npm run typecheck
npm run spike:jvm
```

The successful probe must show:

- `init(String ext)` returns an acknowledgement.
- `homeContent(false)` returns real JSON from the HTTP endpoint.
- the delayed HTTP request produces `JvmSidecarTimeoutError`.
- the timeout sidecar stops and uses a different PID from the normal sidecar.

## csp_Douban assessment

The downloaded public Spider artifact is an Android DEX. Its MD5 matches the public config, but `URLClassLoader` cannot load `com.github.catvod.spider.Douban` from it.

The decompiled class follows the Android CatVod shape (`init(Context, String)` and `String homeContent(boolean)`), but it directly imports `android.content.Context` and CatVod classes. Its `homeContent` calls obfuscated helper classes for HTTP, JSON, result models, and encoded endpoint/config data. The helper closure also contains Android-specific sources and Android/OkHttp runtime dependencies. An empty `init` body does not remove those transitive dependencies.

Decision:

1. Continue the JVM-native route for source-available or deliberately ported Spiders using the new contract and Host.
2. Keep existing Android DEX, including `csp_Douban`, on a separate Android emulator/device runtime. Do not promise automatic DEX-to-JVM conversion.
3. A future JVM `csp_Douban` would be a manual port of its HTTP endpoints and result mapping, not a recompile of the downloaded DEX.

The process is isolated but not a complete security sandbox. First-import trust confirmation remains required, and untrusted Spider execution still needs a separate Windows security boundary.
