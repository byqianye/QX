# QX 影视 G73 startup and first-start spec

## Startup

While the initial typed state request is pending, show the local mark, `正在启动工作台`, and the three operational stages `Initializing Runtime · Loading Database · Starting Engines`. The surface uses the same semantic tokens as the workbench and does not add a network request or artificial delay.

## First start

The first-start surface explains only three actions: add configuration, add local media, and connect an authorised service. Configuration import remains the existing trust boundary: show source summary before confirmation and keep secrets out of the view.

## State consistency

Loading uses a quiet progress bar; empty uses a clear next action; errors include a reason and recovery action; update copy is informational until a real update channel exists. The UI must remain useful offline.
