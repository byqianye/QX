# QX 影视 G73 icon spec

Asset source: `build/assets/qx-yingshi-mark.svg`, generated into `build/assets/qx-yingshi.ico` by `npm run brand:assets`.

## Windows sizes

The ICO contains 256, 128, 64, 48, 32 and 16 pixel entries. All entries use the same geometric mark, transparent outside the dark circular field, with the cobalt tail retained at small sizes.

| Surface | Rule |
| --- | --- |
| Electron app/window | `qx-yingshi.ico`; use the same mark in the main and detached player windows |
| Taskbar / Start menu | Windows selects the closest ICO entry; do not ship a second logo |
| Installer | electron-builder `win.icon` points to the same ICO |
| Renderer brand | Inline SVG, currentColor-compatible shell with the same geometry |

The mark must remain recognisable at 16px, have no text baked into the ICO, and never be loaded from a URL.
