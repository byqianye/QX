# Spike 64: Download manager

Status: complete. Dependency: G63 checkpoint `38f1944` (`checkpoint:
complete G63 local media`).

## Decision

G64 adds a main-process download manager with a small `DownloadBackend`
contract. `Aria2Backend` is the production adapter, while
`FakeDownloadBackend` is the deterministic contract used by unit tests and
packaged E2E. The application does not download or install an aria2 binary.
`QX_ARIA2_PATH` must point to an existing executable; without it the UI shows
`ARIA2_UNAVAILABLE` and no task is started.

The data model persists task metadata and the selected target directory. The
renderer receives an opaque target-directory id and a task reference, never an
absolute filesystem path or the actual request URL. On startup, queued,
starting, and downloading rows are conservatively changed to `paused`; a
future backend can resume them only through an explicit user action.

## Eligibility and boundary

- A source may opt in with `SourceCapabilities.download === true` and a legal
  HTTP/HTTPS download endpoint.
- The explicit Add Download form is also allowed to submit a legal HTTP/HTTPS
  URL. This is the only URL-to-task path exposed by the UI.
- Playback URLs, sniffed URLs, ordinary HLS playlists, BT, magnet, and other
  P2P inputs are not automatically converted into download tasks.
- URLs containing userinfo or common credential query keys are rejected before
  persistence or backend dispatch.
- Filename handling rejects path separators, traversal, absolute/drive/UNC
  forms, Windows reserved device names, trailing dot/space, invalid control
  characters, and collisions. The final name is bounded to 180 characters.

## Backend contract

`DownloadBackend` owns add, pause, resume, cancel, retry, remove, status, and
shutdown. The aria2 adapter starts only the configured executable with
`spawn(..., { shell: false })`, binds JSON-RPC to `127.0.0.1`, and uses a
per-process random secret. Shutdown pauses managed work, asks the managed
process to stop, waits briefly, and only then attempts to terminate that same
process. It does not discover or kill unknown processes.

The secret and the internal URL/path are not included in public task rows,
diagnostic state, normal UI errors, or command history. Backend failures are
mapped to stable codes such as `ARIA2_UNAVAILABLE`, `ARIA2_RPC_FAILED`,
`ARIA2_PROCESS_EXITED`, and `FAKE_ARIA2_CRASHED`.

## Persistence and UI

Schema migration v10 adds `download_target_directories` and `download_tasks`.
The Downloads page reuses the existing Neutral Modern shell and provides
Active, Completed, and Failed views, folder selection, explicit URL entry,
progress/speed/size/status, and Pause/Resume/Cancel/Retry/Remove/Open Folder
actions. The renderer sends typed ids and intents; native folder selection and
folder opening remain main-process callbacks.

## Verification and limits

Focused tests cover eligibility, HLS rejection, URL credential rejection,
filename/path traversal/reserved-name handling, target identity redaction,
duplicate names, all fake backend actions, restart pausing, missing aria2,
RPC authentication, `shell: false`, crash mapping, and server/UI routes.
Packaged E2E opts into the fake backend and verifies first-run completion,
download-page rendering, persisted restart metadata, and path/URL redaction.

Real aria2 is an external environment dependency. It is tested through the
adapter seam when a test supplies an executable/RPC fixture; CI and packaged
E2E do not claim to ship or provision aria2.

G64 does not add source scraping, DRM/account/region bypass, automatic
download of playback URLs, BT/magnet/P2P, or a bundled downloader binary.

Checkpoint: `checkpoint: complete G64 download manager`.
