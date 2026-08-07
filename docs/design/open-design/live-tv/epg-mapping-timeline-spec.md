# EPG mapping and timeline extension

This extension keeps the existing Open Design Neutral Modern tokens, sidebar,
typography, cards, focus treatment, light/dark themes, and Windows desktop
layout. It adds information density to the existing live settings and channel
surfaces without turning the product into a TV launcher.

## Mapping management

The EPG settings surface shows one compact mapping card per visible live
channel. Each card contains the live channel/source, current EPG channel,
method, confidence, status, candidate suggestions, and clear/change actions.
Unique exact/high candidates can be confirmed in one batch action. Medium
alias suggestions remain visibly pending until the user confirms them.

Ambiguous candidates are listed together with no arbitrary default. Alias and
call-sign edits stay on the mapping card and can be removed independently.

## Live channel programme context

The live channel row keeps the existing logo/name/health layout and adds a
single compact programme line. When there is no mapped current programme it
shows `暂无节目` and the mapping status. A mapped current programme shows its
title and time-derived progress; the next programme is shown as a second compact
line when available.

## Timeline

The timeline is a bounded panel that renders only the requested programme
window. It uses the existing panel, row, border, muted metadata, and status-chip
tokens. Empty windows use the existing meta/empty-state treatment. The service
limits the window and row count before the renderer receives data, so the UI
does not create a seven-day DOM tree.

## Interaction states

```text
unmapped -> suggested -> confirmed
        \-> ambiguous
mapped -> clear/change -> suggested | unmapped
timeline hidden -> bounded window -> empty | populated
```

Keyboard focus, disabled pending states, and error presentation reuse the
existing button/input and error patterns.
