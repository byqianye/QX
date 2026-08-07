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
