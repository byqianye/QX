# History design extension

G51 extends the existing QX 影视 Open Design system with one data feature: a
formal History page. It reuses the current neutral-modern tokens, panel,
settings-section, button-row, status-chip, dialog, and empty-state patterns.

The extension is deliberately local to the feature. It does not replace the
main shell, detail drawer, playback line tabs, episode grid, or player.

## Product boundary

- History is a first-class sidebar route.
- The renderer receives sanitized History DTOs through the existing API.
- Resume is always explicit: a stored record never causes silent seeking or
  autoplay.
- Temporary media URLs, proxy credentials, cookies, authorization values, and
  local IPC addresses are not part of the DTO or SQLite history row.

## Responsive intent

The toolbar wraps on narrow widths. History cards remain single-column below
920px and keep the primary action visible without horizontal scrolling.
