# Duopan UC Auth Audit

Status: **AUDITED FROM THE REAL DEX**

Artifact: the real Android DEX used by the device PoC. No credential value is stored in this report.

## Evidence chain

| Question | Evidence | Conclusion |
| --- | --- | --- |
| Why did `playerContent` return unauthenticated? | The real response was `parse=0`, empty URL, message `未登录光鸭, 请去配置中心设置`. `WangPan.playerContent` returns this path when its UC session lookup cannot produce a play URL. | The failure is `AUTH_REQUIRED`, not a generic runtime failure. |
| Which field is required? | `WangPan` and `D` contain the decoded field name `access_token`; `D.i()` builds the bearer value used by authenticated requests. | The required credential payload contains JSON field `access_token`. |
| Where is it read from? | `D.b()` calls `C0112e.c()`. `C0112e.c()` uses the SharedPreferences key `mi.uc`, then falls back to the Host private file `.uc`. | The Host must provision the authenticated JSON through the Android private storage boundary. |
| How does the Android Host provision it? | The Host supplies the real Android `Context` during Spider initialization. The runtime now exposes a credential bridge that writes only to the application private storage path used by this DEX. | Electron does not access Android SharedPreferences directly. |
| How is the configured value injected? | The bridge accepts an explicit user-provided credential payload, validates that it is JSON containing a non-empty `access_token`, and writes the payload to the Host private `.uc` file. | No cookie scraping, password collection, or fabricated token is used. |
| Is the value passed through `ext`? | `Duopan.init(Context,String)` decodes the `ext` object and uses `site` / `site_urls` for source endpoints. The UC token is not read from those fields. | Auth injection is separate from Spider `ext`. |
| Does it depend on SharedPreferences? | Yes. `H.f`/`H.g` are the SharedPreferences accessors, and `C0112e` first reads the `mi.uc` entry. The file fallback is also in the application private files directory. | Host storage compatibility is required; a plain Electron environment is insufficient. |
| Does a helper class need to be available? | `D`, `C0112e`, `H`, and `Init` are in the DEX. `Init.context()` must be initialized before the credential lookup. | The existing Android Context initialization and DEX dependency set must remain intact. |

## Runtime status

- `health`, `loadJar`, class resolution, instance creation, `init`, `searchContent`, and `detailContent` are real-device verified.
- `playerContent` without a configured UC `access_token` is expected to map to `AUTH_REQUIRED`.
- The runtime must continue to expose other sources when Duopan is `AUTH_REQUIRED`.
- Reports and diagnostics redact credential contents and only show `CONFIGURED` or `MISSING`.
