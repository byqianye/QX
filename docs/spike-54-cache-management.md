# Spike 54: Cache management

## Goal

Provide one local service for non-sensitive, reproducible cache files. Cache
management is explicit and bounded; it does not become a background crawler or
a playback-secret store.

## Decisions

- The existing `cache_entries` table is the metadata index. `CacheService` owns
  file creation, reads, expiry, leases, size pruning, and category clearing.
- Cache types are `poster`, `backdrop`, `source-config`, `home`, `category`,
  `search`, `detail`, `subtitle`, `epg`, `parser-metadata`, and `temporary`.
- A cache key is a type plus a SHA-256 digest of stable metadata. The file
  name combines the cache-key digest and content digest, so URLs are never
  Windows file names and two entries cannot accidentally share a deletable
  path.
- TTLs are centralized in `CACHE_TTL_MS`: images are long-lived, search is
  short-lived, detail/subtitle/parser metadata are medium-lived, and temporary
  data is short-lived.
- The default cache limit is 512 MiB, with expired entries removed first and
  least-recently-used entries removed next. Active `CacheLease` files are not
  removed.
- The cache root is resolved once from the application data directories. Every
  path is checked for traversal and symlink/junction escape before access.
- Image input is limited, checked against image signatures and declared MIME,
  and returns a placeholder result on download, MIME, size, or signature
  failure. Remote HTML is never stored as an image.
- Authorization, Cookie, LocalProxy tokens, temporary media URLs, sniffer
  private state, mpv IPC, history, favorites, follows, settings, and the
  database are outside cache clearing.

## UI and API

Settings contains a Storage / Cache section. It shows total size, entry count,
the configured limit, and all cache categories. The actions are explicit:
clear expired, clear images, clear search, and clear all regenerable cache.
The local API is `/api/cache/refresh` and `/api/cache/clear` with a validated
scope.

## Verification evidence

- `tests/cache.test.ts` covers put/get, stable keys, TTL and expiry, LRU and
  size limits, in-use leases, image MIME/signature/size/download checks,
  duplicate requests, category clearing, path traversal, symlink escape,
  restart persistence, and user-data preservation.
- `tests/desktop-ui.test.ts` covers the cache API and invalid clear scope.
- `tests/vue-renderer.test.ts` covers the Settings controls and request wiring.
- `tests/electron-e2e.test.ts` covers the packaged-style cache API contract.
- `src/electron/e2e-launch.ts` verifies the packaged cache root exists while
  the user database remains present after first run and restart.

## Non-goals and risks

- CacheService is not wired into source fetching, image downloading, subtitle
  loading, or parser calls in this goal; those callers can adopt the service in
  later goals without changing the safety contract.
- MIME validation uses bounded content signatures rather than a heavyweight
  image decoder dependency.
- Cache cleanup is local and user-triggered or invoked during bounded writes;
  there is no periodic background cleanup loop.

## Checkpoint

```text
checkpoint: complete G54 cache management
```
