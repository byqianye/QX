# Spike 63: Local media files and folders

Status: complete. Dependency: G62 checkpoint `b0a0b272` (`checkpoint:
complete G62 danmaku`).

## Decision

G63 adds a local-media library owned by the Electron main process. A user can
choose files, choose a folder, or drop files onto the QX window. The main
process registers only those explicit paths, scans only authorized roots, and
serves playback through typed local-media endpoints. The renderer receives an
opaque `local-file:<id>` identity, never the filesystem path.

The existing Neutral Modern sidebar, cards, player stage, history, subtitle
parser, error surface, and light/dark tokens are reused. No network metadata
lookup or source discovery is involved.

## Model and persistence

Schema migration v9 adds `local_media_roots`, `local_media_items`, and
`history.source_type`. A local item is identified by a stable database id and
the canonical authorized file reference plus size and modified time; the
display name is not an identity. The public item exposes both the
`pathIdentity` name from the Goal and the desktop API's `fileReference` alias,
but both values are opaque ids. The database may retain the canonical path so
the main process can reopen an authorized entry.

Folder roots are explicit records. Removing a root cascades its folder items;
removing a file item does not silently remove its history record.

## Access and API boundary

The only path-producing operations are Electron's open-file/open-directory
dialogs, the user drop event, and an already authorized root. The local API
accepts ids for play, rescan, remove, active selection, and subtitle/resource
requests. Locate opens the file picker again; a selected file stays in its
folder root when it is still inside that root, and becomes a standalone
authorized item when the user explicitly locates it elsewhere. There is no
renderer API that calls `shell.openPath`, opens an arbitrary path, or resolves
a path from an item id.

The stream endpoint resolves the id in the main process, validates the file
again, and supports normal byte ranges. Responses are `no-store` and include
`X-Content-Type-Options: nosniff`.

## Supported files and playback

The library recognizes the Goal's local video formats mp4, mkv, webm, mov,
m4v, and m3u8 plus common local audio formats such as mp3, wav, flac, ogg,
aac, and m4a. Recognition is not a codec guarantee. HTML-compatible files
use the existing embedded video/audio path; local m3u8 uses the existing
hls.js path through a rewritten local playlist. Files requiring mpv return
the existing `MPV_UNAVAILABLE` contract when mpv is absent. This contract does
not block HTMLVideo playback for other files, and G63 does not claim to ship a
working mpv binary or add a new fallback engine.

## Folder scanning

The default limits are depth 8, 10,000 media files per scan, and 100 dropped
paths. Scanning is cancellable and yields to the event loop while walking.
Hidden names and system directories are skipped. Symbolic links and junctions
are not followed; every directory and file is canonicalized and checked to be
inside the selected root before it is accepted. The application never scans a
whole disk by default.

Rescan reuses an item when its canonical file reference, size, modified time,
root, and subtitle candidate set are unchanged. Files absent from a completed
scan are marked missing so history can remain available. A cancelled scan does
not guess replacement files or delete the previous item set.

## Local playlists and subtitles

Only relative resources from an authorized local m3u8 may be rewritten. URL
schemes, `file:` references, absolute paths, drive/UNC paths, and references
that escape the authorized root are rejected. Resource URLs contain an opaque
item id and encoded relative token; the token is resolved and checked again
before serving.

Subtitle candidates reuse the existing G47 subtitle formats and are limited to
the media file's directory and a matching stem, such as
`movie.mp4`/`movie.srt`/`movie.zh-CN.ass`. No recursive subtitle search is
performed.

## History, missing files, and privacy

Local playback enters the existing history service with `sourceType=local` and
the stable identity `local:<item-id>`. Position, duration, completion, and
updated time use the same progress writer and resume choices as remote
playback. A missing file returns `LOCAL_MEDIA_NOT_FOUND`; the library can
locate the file through a new picker or remove the item while keeping history.
No other directory is searched to guess a replacement.

History display uses the redacted source label “本地媒体”. Renderer state,
diagnostics, playback-session metadata, and packaged E2E assertions do not
contain the canonical path. The canonical path remains an internal database
reference because the main process must reopen a previously authorized item.

## Verification and boundaries

Focused tests cover picker/drop registration, extension/backend contracts,
folder limits, cancellation, depth, junction/symlink escape handling,
incremental rescan, same-directory subtitles, m3u8 traversal rejection,
missing/locate, history/resume, restart, and path redaction. Renderer tests
cover the local page and opaque actions. Packaged Windows first/restart E2E
covers local MP4 streaming, Range 206, history position, local-page routing,
and restart hydration. Existing portable-mode tests continue to exercise the
same SQLite data-root migration path used by the local library.

G63 does not add Android DEX support, DRM/payment/account/region bypass,
automatic online metadata scraping, third-party media discovery, transcoding,
or a bundled mpv runtime.

Checkpoint: `checkpoint: complete G63 local media`.
