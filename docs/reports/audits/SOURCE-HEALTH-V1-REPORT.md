# Source Health V2

Source Health V2 is durable, advisory state stored as `source-health.json` below the Electron data root. It stores operation counters, latency, cooldown state, safe failure codes, authentication state, and a decaying score; it does not persist raw cookies, tokens, or media URLs.

Defaults:

```text
failure threshold: 3 consecutive failures
cooldown:         10 minutes
score half-life:   6 hours
```

The implementation is covered by `tests/source-health-v2.test.ts` and passed in the full local test run.
