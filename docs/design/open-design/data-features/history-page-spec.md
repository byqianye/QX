# History page — G51 Open Design extension

This page extends the existing Open Design system. It reuses the current
`AppSidebar`, `SettingsSection`, `panel`, `button-primary`, and
`button-secondary` contracts; it introduces no new visual language.

## Structure

- The sidebar exposes a real `History` route beside Browse.
- The workspace header names the page `History` and keeps the current source
  context visible.
- The page opens with search, time sorting, completion/source filters, and a
  recent/continue list.
- Each item shows title, episode, source display name, progress, and an
  explicit Continue or Delete action.
- Batch selection and Clear all are secondary actions and require confirmation.

## Safety and interaction

- Resume is always a user action. Opening a detail page may show a resume
  prompt, but it never seeks or starts playback silently.
- The privacy control pauses new history writes and does not delete retained
  history. Clear all is separate and confirmed.
- Only opaque content identities and safe display metadata reach the renderer;
  playback URLs, proxy tokens, cookies, and authorization headers are not UI
  data.

## Responsive behavior

The list remains a single-column stack below 760px. Search and filter controls
wrap before item content is compressed. Confirmation uses the existing
`.dialog-backdrop` / `.trust-dialog` visual contract.
