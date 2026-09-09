# QX影视

QX影视 is a Windows x64 desktop player for media and live content that the user is authorized to access. It does not ship third-party media sources, credentials, cookies, DRM bypasses, or a hosted parsing service.

## Current delivery status

The release-engineering baseline is recorded under `docs/reports/`. The current
G130 source and playback work is still in progress, so this repository does not
claim stable third-party source coverage or stable production status. The
authoritative task ledger is [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md).

## Windows package

The smallest supported package is the Rust-backed Tauri Windows x64 NSIS package:

```powershell
npm ci
npm run build:windows:minimal
```

The Tauri build compiles `src-tauri/src` into the application executable and keeps
`bundle.resources` empty. It does not include Electron, Android runtime files,
JRE, CPython, mpv, aria2 or third-party source configurations. See
[the handoff entry](docs/PROJECT-HANDOFF.md), [the build guide](docs/BUILD.md), and
[the current status ledger](docs/PROJECT-STATUS.md).

- NSIS installer: per-user installation, Start Menu and Desktop shortcuts, no file associations.
- User data is retained by default when uninstalling. The optional uninstall component can delete it only when explicitly selected.
- Portable mode uses a `data` directory beside the packaged executable when the executable is named `QX影视.exe`.
- The Electron compatibility installer bundles fixed Windows x64 JRE, CPython, mpv and aria2 runtimes. A normal user does not need to install Java, Python, mpv or aria2 when using that path.
- The minimal Tauri installer is the recommended path when package size matters; it statically links the Rust adapter and ships no optional runtime resources.

## Code signing

See [docs/reports/release/CODE-SIGNING-POLICY.md](docs/reports/release/CODE-SIGNING-POLICY.md) for the release signing
provider, maintainer/reviewer/approver roles, privacy statement, and the rules
that distinguish signed production releases from unsigned test artifacts.
See [docs/release-signing.md](docs/release-signing.md) for the exact SignPath,
GitHub Secrets, tag, and acceptance steps.

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
