# QX影视

QX影视 is a Windows x64 desktop player for media and live content that the user is authorized to access. It does not ship third-party media sources, credentials, cookies, DRM bypasses, or a hosted parsing service.

## Current delivery status

The local release-engineering work for R70 and G70-G75 is recorded. G73 still requires the planned Open Design visual review, and G76 still requires validation on a pristine Windows machine. Until both gates pass, this repository does not claim `release_candidate_ready` or stable production status.

## Windows package

- NSIS installer: per-user installation, Start Menu and Desktop shortcuts, no file associations.
- User data is retained by default when uninstalling. The optional uninstall component can delete it only when explicitly selected.
- Portable mode uses a `data` directory beside the packaged executable when the executable is named `QX影视.exe`.
- The installer bundles the fixed Windows x64 JRE, CPython, mpv and aria2 runtimes. A normal user does not need to install Java, Python, mpv or aria2.

## Code signing

See [CODE-SIGNING-POLICY.md](CODE-SIGNING-POLICY.md) for the release signing
provider, maintainer/reviewer/approver roles, privacy statement, and the rules
that distinguish signed production releases from unsigned test artifacts.

## First use

1. Start the app and import your own source/configuration file or URL.
2. Review the import preview and confirm only sources you trust.
3. Search, open details, and play media through the configured source.
4. Add your own local media folders and use Backup & Restore from Settings when you need a portable copy.

## Data and privacy

Normal-mode data is stored under the Electron user-data directory, normally `%APPDATA%\QX影视`. It contains the SQLite database, cache, logs, temporary files, settings and backups. Portable mode stores the corresponding data under the executable's sibling `data` directory. Do not put secrets in bug reports or exported configuration files.

## Limitations

DRM playback, Android DEX spiders, bundled third-party media sources and hosted parsing services are outside this release scope. See [the user guide](docs/user/guide.md), its [chapter index](docs/user/guide.md#分章节阅读), and the release-gate records under `docs/` for troubleshooting and validation status.

## Development verification

```powershell
npm run typecheck
npm test -- --maxWorkers=1 --minWorkers=1 --reporter=dot
npm run electron:e2e:package
npm run python:smoke
npm run mpv:smoke
npm run aria2:smoke
```
