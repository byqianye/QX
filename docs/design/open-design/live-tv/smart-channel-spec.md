# Smart Channel UI Spec

G60 extends the existing neutral-modern Live surface. It does not introduce a new TV-launcher visual system.

## Navigation

The Live management surface has two adjacent tabs:

- `Sources` keeps the existing import, source status, catalog, and player workflow.
- `Smart Channels` exposes user-created channel groups and keeps the selected tab state local to the Live view.

The tab count is visible and the source view remains the default for compatibility with the existing workflow.

## Smart view

The Smart view is ordered as:

1. Manual creation: name, optional group, and source-channel checkboxes.
2. Suggestions: match reason and confidence, with an explicit confirmation action.
3. Smart Channel cards: rename/delete, EPG mapping, and member management.

Each member row shows source/channel identity, availability, health score when present, priority, play, enable/disable, and remove actions. Unavailable members remain visible so source lifecycle changes are understandable.

## States and transitions

- Empty state: explain that a Smart Channel can be created from at least two source channels.
- Suggested state: show exact tvg-id, exact-name, or shared-EPG reason; no automatic creation.
- Available state: show the selected member/source and EPG mode.
- Degraded state: retain the card while marking unavailable members or an unavailable EPG mapping.
- Playing state: member play action updates the existing Live player/session surface.

All actions use the existing button, panel, field, spacing, and responsive grid tokens. The renderer receives typed Live UI state and emits intents; it never reads SQLite or raw source content.
