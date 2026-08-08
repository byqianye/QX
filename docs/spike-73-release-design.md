# G73 release design implementation

The engineering implementation follows the existing OpenDesign Neutral Modern contract and records the release-specific material under `docs/design/open-design/release/`.

Completed in this checkpoint:

- deterministic local SVG/ICO brand asset generation with six Windows sizes;
- OpenDesign release assets are recorded under `docs/design/open-design/release/assets/`;
- same icon wired to Electron windows, electron-packager and electron-builder;
- renderer startup state, first-start guidance and About panel;
- lazy loading for heavy route views;
- offline-only release spec and packaged screenshot acceptance matrix in the browserable HTML artifact.

OpenDesign's first run reported `failed to renew cache TTL: missing field base_instructions`. A later run produced a traceable `qx-g73-visual-spec.html` and `qx-g73-visual-handoff.md`; its scorecard is partial (5/6) because HTML preview execution was rejected by a workspace-context boundary. Independent light/dark preview and the packaged first/restart light/dark visual matrix now exist, but visual acceptance still requires final manual review and installer/shortcut sign-off.
