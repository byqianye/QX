# Local Media Library component specification

## Direction

Local Media is a focused extension of the existing Neutral Modern desktop
workbench. It keeps the current sidebar, typography, semantic color tokens,
`panel`/card surfaces, `PlayerControls`, dialog patterns, toast/error states,
and light/dark behavior. It does not introduce a file-manager shell, a second
visual language, or a TV-launcher layout.

## Placement

- The sidebar adds one “本地媒体” entry with the same active and focus states
  as the existing navigation.
- The page header explains that only user-selected files and folders are
  read.
- The first panel contains Open File and Add Folder actions.
- A bordered drop zone accepts user drops made inside the QX window.
- The existing embedded player is shown below the library cards after a local
  item is selected.

## Library controls

The toolbar has Continue Watching, Recent, Folders, and All Media views plus a
local search field, Rescan, and a cancellable scan action. Folder cards expose
Rescan and Remove Folder. Media cards expose Play, Locate, and Remove; a
missing item with local history also exposes Remove History. Continue Watching
filters to incomplete progress, while Recent sorts by the local history
updated time. The renderer sends typed ids and intents; it does not display or
construct a full filesystem path.

## States

- Empty: explain how to open a file or add a folder.
- Scanning: keep the existing library visible, show progress, and expose
  Cancel.
- Ready: show media cards with extension, size, type, and matching subtitle
  availability through the existing player.
- Missing: preserve the card and history, disable Play, and offer Locate,
  Remove, or Remove History.
- Error: show the typed error code and a safe, actionable message in the
  existing error surface.
- Resume: when local history has progress, show Continue or Start Over before
  seeking.

## Interaction and accessibility

All actions remain real buttons with the existing focus-visible ring and hit
target. The drop zone is supplementary to the file picker and does not accept
URLs or pasted path text. Scan and picker actions are disabled while their
request is pending. Missing/error messages are text content, not HTML. The
player keeps the existing subtitle controls and keyboard/browser media
behavior.

## Density and safety

The page uses the same card grid and spacing tokens as other media views. The
main process owns scan limits and path authorization; the renderer only holds
opaque item ids and safe metadata. No poster is fetched from the network and
no local path is placed in a CSS value, diagnostic label, URL query, or history
display string.
