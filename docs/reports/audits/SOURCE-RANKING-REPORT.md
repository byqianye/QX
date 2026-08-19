# Source Ranking V2

Eligible sources are ordered by:

1. eligibility (authentication block and cooldown are excluded);
2. query match score;
3. compatibility status;
4. persisted health score;
5. observed latency;
6. stable source id as the final tie-breaker.

Search uses a progressive bounded strategy: a small Tier A is attempted first, then remaining eligible sources are added only when the result/coverage gate is not met. The implementation keeps the configured source count separate from the actually searchable and currently healthy counts.
