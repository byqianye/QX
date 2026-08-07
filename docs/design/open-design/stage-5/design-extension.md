# Stage 5 Open Design extension: G62 danmaku

G62 extends the existing Neutral Modern desktop workbench. It reuses the
sidebar, `SettingsSection`, `panel`, `PlayerControls`, state chips, error
surface, focus-visible treatment, and light/dark semantic tokens. It does not
introduce a TV-launcher layout, a second color system, decorative gradients,
or a separate player shell.

## Placement

- The danmaku controls live in the existing Settings page as one section.
- The overlay sits inside the current player stage, above the video and below
  the existing player controls.
- Live playback reuses the same overlay component and controls; the timeline
  kind is state, not a new page.

## States

The section exposes idle, loading, ready, empty, and error states using the
existing metadata/error patterns. Loading and clear actions disable while a
request is pending. A missing or rejected source leaves the media player
usable and shows a recoverable danmaku error.

## Accessibility and motion

Controls keep the existing 44px hit target and keyboard focus ring. Danmaku is
decorative (`aria-live="off"`) and never steals focus. The existing reduced
motion rule pauses/removes overlay motion while preserving readable text and
player controls.

## G63 Local Media Library

G63 keeps the same Neutral Modern workbench. The sidebar adds a single 本地媒体
entry, and the page reuses the existing panel, card, search, button, player,
error, toast, focus, and light/dark token vocabulary. The page is a media
library rather than a general-purpose file manager.

The page contains Open File and Add Folder actions, a user-drop zone, Continue
Watching/Recent/Folders/All Media tabs, search, rescan/cancel controls, folder
cards, and media cards. Cards show only safe metadata and opaque item
identities. The existing EmbeddedPlayer and subtitle controls remain the sole
playback surface.

Empty, scanning, ready, missing, error, and resume states use the existing
metadata and error patterns. Missing media keeps its history visible and
offers Locate or Remove. Scanning keeps the current library visible and makes
Cancel an explicit action. All controls retain the existing focus-visible
treatment and hit target; the drop zone accepts only user drops in the QX
window and never accepts URL/path text as a pasted command.
