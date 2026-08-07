# Spike 60: Smart Channels

Status: complete. Dependency: G59 EPG matching.

## Decision

Smart Channels are user-owned groups of live channels. The user creates the group and controls its members, order, enabled state, preferred member, and explicit EPG mapping. Suggestions are advisory only and are never persisted until the user confirms them.

Suggestions are generated from exact `tvg-id`, normalized channel name, or a shared confirmed EPG mapping. They only combine channels from at least two sources. No fuzzy match or random merge is performed.

## Data model

Schema v8 adds:

- `smart_channels`: name, optional logo/group, manual sort order, preferred member, explicit EPG mapping, and timestamps.
- `smart_channel_members`: Smart Channel membership, per-member priority, enabled flag, and foreign keys to the Smart Channel and live channel.

Create, member removal, and member reorder operations use SQLite transactions. Deleting a source cascades its live channels and members; the Smart Channel row remains and reports unavailable when no member remains.

## Playback and health

Selection order is explicit manual member, persisted preferred member, known runtime health score, then manual priority and stable ID. A disabled, deleted, or unsupported member is not selectable. Manual playback records the active Smart Channel and member for the UI.

The current health API accepts a bounded runtime score for deterministic selection tests and UI/API integration. It is intentionally not a claim of real network probing; a future health probe may supply scores through this seam.

## EPG

An explicit Smart Channel mapping always wins. Without one, EPG is inherited only from the persisted preferred member. Conflicting or ambiguous inherited mappings remain `conflict`; no candidate is selected implicitly. Deleted EPG sources are reported as `unavailable`.

## UI and API

Live has `Sources` and `Smart Channels` tabs. The Smart view supports manual creation, suggestion confirmation, rename, deletion, member priority/enabled/remove actions, member playback, and explicit EPG selection. The desktop API exposes matching create/update/delete/member/selection/playback/EPG/health operations.

## Verification

- Smart Channel repository/service/API tests cover CRUD, transaction rollback, member priority, health selection, manual selection, source disable/delete, EPG inheritance/override/conflict, and restart persistence.
- Renderer tests cover the Smart Channels tab and actions.
- `npm run typecheck`, `npm test`, renderer build, Electron build, and packaged first/restart E2E pass.

## Non-scope

Real network health probing, automatic fuzzy matching, Android DEX compatibility, DRM, and third-party source parsing are not part of G60.
