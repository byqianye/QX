# Favorites page spec — G52

## Information architecture

```text
Favorites
├── Group sidebar
│   ├── Default group
│   ├── Custom groups with counts
│   └── Create group
└── Content workspace
    ├── Search and sort toolbar
    ├── Grid/List toggle
    ├── Group title and rename/delete actions
    └── Favorite cards
```

## States

- Empty group: explain that a title can be favorited from its detail drawer.
- Available source: show source mark and open detail action.
- Unavailable source: retain the card, explain that the original source is
  unavailable, and offer delete or search by title.
- Pending request: disable the affected controls while keeping the current
  state visible.
- Delete favorite: require confirmation.
- Delete non-empty group: require an explicit move-to-default or delete-
  favorites choice; cancel leaves both group and favorites unchanged.

## Interaction contract

Manual up/down controls submit the complete ordered IDs for the active group.
Sort selectors are view-only until a manual order action is requested. Opening
a favorite checks the current source identity first; a mismatched source
returns a safe “source switch required” error rather than trying another source.
