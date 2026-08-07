# Spike 53: Follow updates

## Goal

Add a local, restart-safe following loop on top of the SQLite data layer, playback history, existing Spider detail calls, and the Open Design desktop shell.

This goal provides in-app update state only. It does not provide cloud notifications, Windows Toast, or a background service.

## Decisions

- A follow identity is the stable `sourceId + vodId` identity used by history, encoded through `historyIdentity` with a fixed `follow` episode marker.
- `FollowService` is the only business entry point. Renderer code receives `FollowUiState` and never opens SQLite.
- A follow record stores the title, safe poster, latest episode ID/name, watched episode ID/name, known episode count, check timestamps, update flag, safe error code, and enabled flag.
- Follow detail parsing reuses the normalized detail payload and the existing `parseVodPlayback` catalog. It chooses the longest non-empty ordered playback line for the episode list; it does not call a hidden or alternate source endpoint.
- Update detection compares the stable latest episode ID first, then the episode name when no ID is available. The ordered list supplies the latest item. Episode count alone never marks an update.
- Checks run only when the user opens or refreshes the Follow page (and through the same API for a persisted Follow page). There is no high-frequency background loop.
- Each check goes through the current session `detailContent` path, so the existing source health/circuit-breaker behavior remains in force. FollowService additionally serializes checks per source and limits total concurrent checks to two by default. A failed source records a safe error code and does not cancel other sources.
- History progress is read to update the watched episode. Marking an item watched or unwatched changes follow state only; it never deletes the original history row.
- The UI uses one app badge, status chips, a Follow page, a refresh action, source-unavailable state, and a confirmation dialog for cancellation. It does not emit system or cloud notifications.

## Schema

SQLite schema version 3 adds the non-sensitive `poster` column to `follow_items`. The migration is additive and keeps all prior follow rows valid.

Follow rows do not contain playback URLs, proxy session URLs, cookies, authorization headers, tokens, or parser credentials. Posters are reduced to safe HTTP(S) URLs without query or fragment data before persistence.

## Verification evidence

- `tests/follow.test.ts` covers duplicate identity, cancellation, stable IDs, name/extra-episode changes, count-only no-op behavior, source failure isolation, concurrency, history synchronization, manual watched state, restart persistence, and unavailable-source state.
- `tests/vue-renderer.test.ts` covers the Follow page, sorting/search controls, update badge, source failure display, refresh/open/delete actions, watched actions, and detail-page follow controls.
- `tests/electron-e2e.test.ts` covers Follow API operations in the playable fixture, manual refresh, watched/unwatched actions, badge state, and the existing history/playback flow.
- `src/electron/e2e-launch.ts` audits persisted follow rows after packaged first-run and restart E2E, including privacy markers and follow identity persistence.

## Non-goals and risks

- Source availability is represented against the currently active source. This goal does not invent a source registry or silently switch sources.
- A source with no detail capability cannot be checked and reports a controlled error.
- The current default concurrency is deliberately conservative; a future low-frequency scheduler can be added as a separate goal.

## Checkpoint

```text
checkpoint: complete G53 follow updates
```
