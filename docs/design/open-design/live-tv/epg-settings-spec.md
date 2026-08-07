# EPG settings extension

This is an extension of the existing Open Design live settings surface. It keeps
the current sidebar, Neutral Modern color tokens, typography, panel/card shape,
focus treatment, light/dark behavior, and Settings layout.

## Entry and layout

The existing live settings page gains an `EPG` section below live source
management. The section is a compact two-column panel at desktop widths:

1. Add-source form: source name, URL or local file content, and Preview.
2. Preview/status panel: channel count, programme count, invalid count, issues,
   and Apply/Clear actions.

At narrow widths the columns stack. The form keeps the existing minimum control
height and keyboard focus ring. No TV launcher, remote-control layout, oversized
television typography, or new color system is introduced.

## Saved source cards

Each saved EPG card shows only safe metadata:

- name and source type
- enabled/disabled status
- channel and programme counts
- last successful refresh time
- sanitized error text when the last refresh failed
- Enable/Disable, Refresh, and Remove actions

The card does not render raw XML, request headers, cookies, authorization values,
or a full sensitive URL. A failed refresh leaves the previous counts visible and
adds the error state beside the card actions.

## Interaction states

```text
empty -> editing -> previewing -> preview-ready -> applying -> saved
                                      \-> error
saved -> refreshing -> saved
                   \-> saved-with-error (last-known-good retained)
```

Loading uses the existing loading treatment. Empty state explains that an EPG
source must be added explicitly. Error state exposes the stable error code and a
short actionable message. Preview is not persisted until Apply succeeds.

## G58 boundary

G58 provides source management and stored programme data only. Channel mapping,
timeline presentation, automatic matching, and cross-source Smart Channel
merging are deliberately reserved for G59 and G60.
