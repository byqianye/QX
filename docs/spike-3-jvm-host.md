# Spike 3: JVM-native Spider Host

Spike 3 established the JVM sidecar foundation on Windows x64 with JDK 21:

- `URLClassLoader` loads a user-selected Spider Jar.
- The Host invokes the Spider through reflection.
- stdin/stdout carry NDJSON requests and responses.
- The Node sidecar owns startup, request timeouts, destroy, and process cleanup.

Spike 4 replaces the temporary Map-based fixture contract with the CatVod-like contract and a real HTTP Spider. See [spike-4-jvm-http.md](spike-4-jvm-http.md).

The public `csp_Douban` artifact remains Android DEX and is not a JVM Jar input. The DEX/runtime decision is recorded in `docs/spike-2-runtime-options.md` and the Spike 4 evaluation.
