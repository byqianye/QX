# Live failover UI spec

G61 extends the existing neutral-modern Live surface. It does not introduce a
TV-launcher visual system or expose raw stream metadata.

## Health panel

The Sources tab keeps the health panel beside the current Live playback state.
It contains:

- a failover mode selector: Off, Ask, Auto;
- a compact score and first-frame/playlist/segment/buffer summary;
- a prompt or progress card with the current and next redacted candidate;
- a details panel with session, channel, Smart Channel, member, stream label,
  score reason, attempts, cooldown, and manual override.

Unknown values are displayed as `unknown`, not as zero or unhealthy. Source and
stream labels are display names only; URLs, headers, cookies, and raw event
payloads stay in the desktop/runtime boundary.

## Actions

In Ask mode the prompt offers:

- `尝试下一条` — approve the next finite candidate;
- `取消` — cancel the current failover run;
- `保持当前` — stop automatic movement and set the manual override window;
- `返回稳定线路` — return to the last successful candidate when available;
- `查看详情` — toggle the redacted debug fields.

Auto mode uses the same state card and action surface while attempts are in
progress. Off leaves the health summary visible but does not start a switch.

## Continuity

Smart Channel playback retains the selected Smart Channel identity and EPG
timeline while a member or line changes. Only playback source, line, and health
state change. Existing Live, EPG, and Smart Channel components keep their
spacing, button, panel, and responsive layout tokens.
