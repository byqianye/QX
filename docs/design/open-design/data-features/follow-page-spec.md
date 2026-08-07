# Follow page extension

This document extends the existing Open Design desktop shell. It does not replace the G26 layout, sidebar, spacing scale, or responsive behavior.

## Entry points

- The sidebar adds a `追更` item beside History and Favorites.
- The item shows a small numeric badge when one or more follow records have `updateAvailable`.
- The detail drawer exposes `加入追更` and `收藏并追更`. The latter creates both records without making ordinary favorites follow automatically.

## Page structure

```text
Follow page
├── search field
├── sort select: updates first / recent / title
├── manual refresh button
├── update count chip
└── follow cards
    ├── safe poster or initial
    ├── title and source state
    ├── latest episode / watched episode
    ├── status chip
    ├── last checked time / safe error code
    └── open detail / mark watched / mark unwatched / cancel follow
```

## State presentation

- `updated`: accent chip and update-first ordering.
- `caught-up`: success chip.
- `checking`: loading chip; refresh and watched actions are disabled while the request is active.
- `error`: warning chip with the stored safe error code.
- `sourceAvailable = false`: warning source label and no open-detail action. The record remains visible and can be searched or cancelled.

Cancellation uses the same confirmation-dialog pattern as History and Favorites. The dialog explicitly states that playback history and favorites are not deleted.

## Responsive behavior

- Desktop cards use a compact poster column and a flexible content column.
- Narrow windows collapse the toolbar to one column and reduce the poster width.
- Titles remain clipped in the card header; full values remain available to the DOM and accessible labels.
- The update badge is intentionally small and stays in the sidebar information hierarchy; it is not a system notification.

## Interaction boundary

The renderer emits typed intents only. The desktop UI server owns FollowService, calls the existing detail path for refresh, and returns the normal API state envelope. No renderer component accesses SQLite or a Spider directly.
