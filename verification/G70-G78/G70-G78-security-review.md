# Security review

`npm audit --audit-level=high` and production audit reported 0 vulnerabilities. Secret-pattern scan found no hardcoded credentials. Runtime hashes, packaged fallback boundaries, shell=false process launches and aria2 localhost RPC were covered by tests/smokes.

