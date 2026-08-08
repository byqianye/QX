# QX 影视 G73 installer spec

The NSIS installer uses the same `qx-yingshi.ico` for the executable, installer, desktop shortcut and Start menu shortcut. It remains per-user, allows a custom install directory, preserves user data by default, and keeps the optional delete-data action explicit and unchecked.

The installer surface must remain quiet and operational: product name, version, install directory, progress, completion, and an explicit launch shortcut. No remote artwork, CDN, or unverified feature claim is allowed.

## Renderer bundle review

Heavy route views are lazy-loaded (`local`, `live`, `downloads`, and EPG settings). This is measured by the generated chunk list; warning thresholds are not changed to hide a large initial chunk. The review records initial chunk size, route chunk names, and whether the first-start state remains responsive.
