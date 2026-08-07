# Release security review

状态：自动化审计完成；clean Windows、代码签名和法务复核仍是外部门槛。

| Finding | Evidence | Status |
| --- | --- | --- |
| Dependency vulnerabilities | `npm audit --audit-level=high` and `--omit=dev` | 0 high/critical reported |
| Bundled runtime integrity | G70 manifest archive and executable SHA-256; fixed archive validation in package build | pass in release build |
| Host runtime fallback | packaged resolver requires the manifest; external Java/Python fallback is development-only | pass in packaged E2E/no-JDK |
| Python environment injection | packaged sanitizer removes `PYTHONHOME`, `PYTHONPATH`, `PYTHONUSERBASE`, `VIRTUAL_ENV` | unit-tested |
| Process/RPC boundary | mpv/aria2 use argument arrays and `shell=false`; aria2 binds localhost with random secret/port | focused tests + real smoke |
| Credential leakage | constrained repository secret-pattern scan | no hardcoded credential found |
| Clean-machine install security | NSIS install/upgrade/uninstall on pristine Windows | pending G76 |

No Critical/High finding is being silently waived. A production release remains blocked by G73 visual review and G76 clean-Windows validation.
