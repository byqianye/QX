# Android Source Compatibility V2

The auditor probes the configured sources through their actual runtime, class loading, init, search, detail, and player contracts. It does not inject mock Spider responses or hard-code media URLs.

The real QX VM audit on 2026-08-12 reported:

```text
configured sources  39
searchable          33
search PASS         3
detail PASS         3
player PASS         1
fully playable      1
```

The golden source was the real Android DEX `csp_Jianpian` / `com.github.catvod.spider.Jianpian`:

```text
init       PASS
search     PASS, resultCount=60
detail     PASS, resultCount=1
player     PASS, resultCount=1
status     FULLY_PLAYABLE
```

The report records source-specific limitations instead of broadening compatibility claims: 5 timeouts, 2 init failures, 1 search failure, 1 authentication-required source, and category-only/live/music/education/netdisk sources.
