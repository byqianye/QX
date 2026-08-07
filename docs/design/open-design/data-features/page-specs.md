# History page specification

## Route

`History` is a persistent top-level route beside Browse and Settings. The
current route is stored using the existing desktop navigation persistence.

## Page regions

1. Filter toolbar: search, status, source, and sort.
2. Privacy section: pause new history recording without deleting retained rows.
3. Recent-history heading with a confirmed clear action.
4. History list or the shared empty state.

Each row shows title, source display name, episode, progress, last updated
time, and actions for explicit resume, deleting progress, or deleting the row.

The list supports recent, continue-watching, completed, search, time/title sort,
source filtering, single delete, selected delete, and clear-all.
