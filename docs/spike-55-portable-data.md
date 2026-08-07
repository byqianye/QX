# Spike 55: Portable mode and data directory management

## Goal

Make every business data path resolve through one directory seam and add a
safe normal/portable data mode. A mode change is a user-confirmed migration;
it is never an implicit move during startup.

## Resolver rules

- Normal mode uses Electron `app.getPath("userData")` as `DataRoot`.
- Portable mode is selected only for a packaged executable named
  `QX影视.exe` when a sibling `data/` directory exists.
- Development mode is always normal, even when the source tree contains a
  `data/` directory.
- The resolver returns `DataRoot`, `Database`, `Cache`, `Logs`, `Temp`,
  `Backups`, and `Settings`. Main-process consumers use these returned paths;
  they do not reconstruct paths from `cwd`, `__dirname`, or the executable
  directory.
- The explicit mode preference is stored outside the data payload so a user
  who chooses normal mode can recover from a non-writable portable directory.
  It contains only mode and, when selected, the user-chosen root.

## Startup and permissions

Startup creates the known directories and writes a short-lived probe file in
`DataRoot` and `Cache`. Portable failures use the stable code
`PORTABLE_DATA_NOT_WRITABLE`. The desktop startup offers normal mode, another
directory, or exit; no silent fallback changes the selected data.

## Migration

`DataStorageService` copies the database, cache, logs, temp, backups, settings,
trust file, and legacy migration files into a temporary sibling directory. It
opens the staged SQLite database read-only and requires `PRAGMA integrity_check`
to return `ok` before installing it.

If the target already contains data, the allowlisted target entries are copied
to `backups/mode-switch-*` first. The staged entries are then installed. When
returning from portable to normal, the old `data/` directory is renamed to a
timestamped `.previous-*` directory after the copy; it is retained, not
deleted. A failed validation leaves the source untouched and removes the
temporary stage, returning `DATA_MIGRATION_FAILED`.

The running app flushes playback progress, closes the SQLite layer and shell,
then performs the migration and relaunches. This keeps live services from
writing to the source while files are copied.

## UI and process ownership

Settings includes Storage / Portable. It shows the current mode, a redacted
data-root label, database/cache/total sizes, write status, an open-folder
action, and explicit normal/portable actions with confirmation. Cache clearing
continues to use G54's regenerable-cache boundary.

The Electron main process owns the single-instance lock. A second instance
focuses the existing window and does not open the same SQLite database.

## Verification evidence

- `tests/data-directory.test.ts` covers normal mode, portable detection,
  development-mode guarding, directory preparation, permission error,
  database/cache migration, round-trip migration, backup retention, staged
  integrity validation, source preservation, and restart-mode resolution.
- `tests/desktop-ui.test.ts` covers storage state, open-folder, confirmation,
  and switch API validation.
- `tests/vue-renderer.test.ts` covers the Storage / Portable Settings section.
- `tests/electron-e2e.test.ts` and packaged E2E cover redacted normal storage
  state, restart persistence, cache root, database preservation, and process
  cleanup.

## Non-goals and risks

- This goal provides migration-before-switch backup protection, not the full
  user-facing backup/restore product reserved for G69.
- Arbitrary Electron profile files are not copied; only application business
  data and the allowlisted legacy files move.
- A mode switch requires an app restart so existing controllers never keep a
  stale SQLite handle.

## Checkpoint

```text
checkpoint: complete G55 portable data mode
```
