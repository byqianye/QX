# Automatic Fallback V2

The fallback path is bounded and source-aware. Retryable failures include source timeouts, player failures, upstream media 403/404, HLS manifest/segment failures, and fatal player errors. Authentication/DRM requirements and explicit user cancellation are not silently retried.

The implementation records fallback health and keeps source failures local. A failed Android DEX source no longer calls the global RuntimeManager destroy path; only that source's runtime cache entry is invalidated and recreated.

The regression is covered by `tests/spider-runtime.test.ts` and `tests/auto-fallback-v2.test.ts`.
