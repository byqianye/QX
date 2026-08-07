# History component specification

| Component | Reused pattern | Feature state |
| --- | --- | --- |
| `HistoryView` | `panel`, `settings-section`, `button-row` | loading via shared pending state |
| History toolbar | real labels and existing form controls | filter/search/sort |
| History item | `panel`, `status-chip`, primary/secondary buttons | continue/completed |
| Resume prompt | `panel` and player-stage action row | continue/beginning/delete/cancel |
| Delete dialog | `dialog-backdrop` and `trust-dialog` | single/selected/all confirmation |
| Empty state | shared `state-card empty-state` | no matching history |

All interactive controls retain visible focus, keyboard access, and a minimum
44px hit area. Status is expressed with text as well as color.
