# G62 danmaku component specification

## `DanmakuOverlay`

Inputs are the typed `DanmakuUiState` and the current player time. The
component computes a bounded list of `DanmakuRenderItem` values, maps each
item to a safe track/style, and renders plain text spans. It does not mutate
the `<video>` element or fetch, persist, or parse source data.

Supported visual modes are scroll, top, bottom, and reverse. The service
settings define opacity, font size, speed, density, display area, active item
limit, per-second limit, and track count. Top/bottom items use centered fixed
placement; scroll/reverse items use the existing player stage animation.

## `DanmakuSettingsPanel`

The panel emits `load`, `clear`, and `settings` intents. It accepts JSON/XML
through the browser file picker and emits the file text to the main-process
API; it never reads an arbitrary path. Keyword, safe regex, type, and source
filters are visible alongside the basic visual controls.

## Failure and safety contract

Source errors are shown as typed, actionable text. User text is inserted with
text binding only. URL/path-like source labels are redacted before display;
raw headers, user hashes, and raw payloads are not part of the renderer state.
