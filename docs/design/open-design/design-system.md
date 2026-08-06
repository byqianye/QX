# QX 影视设计系统

来源：本次校正后的 UTF-8 Open Design 运行生成的 `DESIGN.md`，按仓库命名归档。方向为 Neutral Modern / 安静的桌面工作台。

## Tokens

```css
:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --fg: #111111;
  --fg-2: #111111;
  --muted: #6b6b6b;
  --meta: #6b6b6b;
  --border: #e5e5e5;
  --accent: #2f6feb;
  --accent-on: #ffffff;
  --success: #17a34a;
  --warn: #eab308;
  --danger: #dc2626;
  --font-display: "Inter", -apple-system, system-ui, sans-serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", monospace;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-pill: 9999px;
  --shadow-raised: 0 8px 24px rgb(17 17 17 / 8%);
  --focus-ring: 0 0 0 3px color-mix(in oklab, var(--accent), transparent 70%);
}
```

实现的 dark theme 只覆写语义 token，不在组件中引入第二套 raw color。组件 CSS 禁止新增 hex、渐变、发光和外部图片。

## 尺寸与布局

- 4px 间距基线：4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 80px
- 侧栏：1280px 为 232px；1440px、1920px 为 248px
- 顶栏：64px；桌面内容 gutter：24px
- 详情抽屉：420px / 456px / 不超过 520px
- 1280px 最少 4 列；1440px 5 列；1920px 6–7 列
- 可点击控件最小命中区域 44×44px
- raised surface 使用 `--shadow-raised`；普通卡片保持 flat，不用装饰性阴影

## 视觉与状态

工作区使用 `--bg`，卡片/抽屉/弹窗使用 `--surface`；`--accent` 只用于当前导航、标签和一个主要动作。`--success`、`--warn`、`--danger` 必须与文字或图标一起表达状态，不能只靠颜色。按钮与输入框保持清晰 focus-visible；`prefers-reduced-motion` 时取消位移和淡入。

字号层级为 12 / 14 / 16 / 20 / 24 / 32px，正文行高 1.5–1.7，标题行高 1.3。组件状态明确覆盖 hover、active、selected、disabled、focus、loading、error、warning、success、playing；播放错误必须同时呈现原因和可执行恢复动作。

不使用紫蓝渐变、玻璃拟态、装饰插画、虚构指标、lorem ipsum、彩色左边框卡片或外部图片 CDN。功能图标为本地单色 SVG，使用 `currentColor`。
