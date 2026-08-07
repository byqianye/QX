# Downloads component specification

## Direction

Downloads is a focused extension of the existing Neutral Modern desktop
workbench. It keeps the current sidebar, typography, semantic status colors,
panel surfaces, button states, error surface, and light/dark behavior. It does
not introduce a second visual language or a file-manager shell.

## Placement

- Add Downloads to the primary sidebar with the same selected and focus states
  as the other workbench destinations.
- Use a compact page header with a backend availability chip and a short
  explanation that only explicit HTTP/HTTPS downloads are accepted.
- Put the selected folder and Select Download Folder action in the first
  settings row.
- Put the explicit URL form below it. The form asks for an optional title,
  HTTP/HTTPS URL, optional filename, and one of the opaque selected-folder ids.

## Task views

Use three tabs: Active, Completed, and Failed. Each row shows title,
sanitized filename, progress/size, speed, and the typed status. Actions are
intent buttons: Pause or Resume, Cancel, Retry, Remove, and Open Folder.
Removed rows are not shown in the normal list. A task reference is opaque and
never rendered as the request URL.

## States

- Empty: explain that a folder must be selected before adding a task.
- Backend unavailable: keep the form and persisted metadata visible, show
  `ARIA2_UNAVAILABLE`, and explain that the user must configure aria2.
- Queued/starting/downloading: show progress and Pause/Cancel.
- Paused: show Resume/Cancel.
- Completed: show final size and Open Folder/Remove.
- Failed/cancelled: show a safe error code and Retry/Remove.
- Restarted: show persisted rows as paused when work was interrupted; do not
  imply that a background download continued while the app was closed.

## Interaction and accessibility

Every action is a real button with the existing focus-visible ring and hit
target. Pending operations disable only the relevant controls. Tabs use the
existing tab-row treatment. Status is expressed with text as well as color.
Error messages are text content, not HTML. Folder selection and folder
opening are native main-process actions; the renderer cannot type or construct
an arbitrary filesystem path.

## Density and safety

The page uses the same panel and row spacing as Settings and Local Media.
Target directories are displayed by safe display name and opaque id only.
Task rows contain no absolute path, Cookie, Authorization, token, or secret.
The UI does not offer BT/magnet/P2P, does not turn sniffed playback URLs into
downloads, and does not claim that an external aria2 binary is bundled.
