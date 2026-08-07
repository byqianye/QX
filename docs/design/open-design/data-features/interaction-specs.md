# History interaction specification

## Resume

Opening a matching detail page displays the stored episode and position. The
user chooses Continue, From beginning, Delete progress, or Cancel. Continue
seeks only after the playback source has loaded. From beginning clears the
stored position before starting. If the original line is unavailable, the
episode identity may be matched on another line; if identity cannot be
confirmed, the detail page opens without autoplay or seeking.

## Destructive actions

- Single delete and selected/all clear require confirmation.
- Delete removes both the history row and its progress row.
- Clear all is separate from pausing recording and does not happen on exit.
- Pause recording prevents new writes while retaining existing history.

## Accessibility and motion

Dialogs expose a clear cancel action and keep focusable controls in the normal
DOM order. Reduced-motion users receive the same state changes without relying
on animation.
