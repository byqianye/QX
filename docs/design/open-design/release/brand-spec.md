# QX 影视 G73 brand spec

Source: existing OpenDesign `Neutral Modern` contract in `docs/design/open-design/`. This release layer adds only the Windows release surfaces; it does not redesign the media workbench.

## Tokens

```css
--bg: #fafafa;
--surface: #ffffff;
--fg: #111111;
--muted: #6b6b6b;
--border: #e5e5e5;
--accent: #2f6feb;
```

Typography uses Windows system sans (`Segoe UI Variable`, `Segoe UI`, `system-ui`) and a system mono stack for version/runtime values. Dark mode overrides semantic tokens only; components do not introduce raw colors.

## Rules

1. Quiet desktop workbench: light-gray work area, white content surfaces, thin borders.
2. One cobalt accent marks the active state and the primary action; status also uses text and icon shape.
3. Brand mark is an original geometric Q/X mark, rendered locally as SVG/ICO; no third-party or CDN asset.
4. Release surfaces use short operational copy and never expose tokens, credentials, or full local paths.
5. Reduced motion removes progress animation and preserves the same state hierarchy.
