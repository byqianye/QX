# Favorites design extension

G52 extends the existing neutral desktop workbench with a first-class Favorites
route. It reuses the existing sidebar, panel, button, status-chip, empty-state,
and confirmation-dialog contracts; no new visual language is introduced.

## Product boundary

- The sidebar exposes `Favorites` beside `History` and Browse.
- The page has a group sidebar and a content workspace. Group counts remain
  visible while the content area supports search, sort, and Grid/List layout.
- Each card exposes source display name, availability, title metadata, open or
  alternate-source search, move group, manual up/down order, and cancel
  favorite.
- A non-empty group deletion always presents the two explicit choices: move
  favorites to the default group or delete those favorites.
- The detail drawer shows `Favorite` or `Favorited` and, when favorited, a
  group selector. The action never stores playback state.

## Safety and unavailable sources

Only safe content metadata crosses the main-process boundary. Playback URLs,
proxy credentials, cookies, authorization headers, local paths, and IPC
addresses are excluded. When the current source does not match a favorite's
source, the card says the source is unavailable and keeps the original favorite
identity; it never silently substitutes another source.

## Responsive intent

The group sidebar moves above the content below 1000px. The toolbar stacks and
the card grid becomes one column below 720px. All actionable controls retain
the shared 44px minimum target and confirmation uses the existing dialog
backdrop.
