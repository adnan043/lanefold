# Lanefold: visual identity (as built after Phase 1)

What the look IS in `src/styles/global.css`, `src/styles/app.css`, `src/styles/i18n.css` and `src/app/app.css` (+ `src/app/settings/settings.css`). Intent is in SPEC §12; where this file and the code differ, the code is the truth and this file should be corrected. Rules that never bend: tokens only (no hex in screens), no `style=""`, no one-sided colored stripe, never color alone, logical CSS properties.

## 1. Principles
- Calm warm neutrals, ONE accent, generous whitespace, 4 px grid in spirit (rem steps of 0.25).
- State is shown with a dot, icon, badge, soft fill or a full 1 px border. Never a side or top bar.
- The dashboard kit (`src/portal/ui`) is the only component set; the app (`/app`) reuses its shell classes (`app-*`) and adds `lf-*`.
- Matches Trello on purpose (owner's decision, 2026-11-04): dark glass lanes and cards on the board (`src/app/boards/trello.css`), a dark Trello-style card back in both themes (`src/app/cards/trello-card.css`), lane collapse button, round header buttons. Both files win over `design.css`/`cards.css` by `.app-shell` / `.cd-dialog` specificity. The floating bottom dock on phones and the type-only wordmark stay.

## 2. Color tokens (`global.css`, defined THREE times: `:root`, `:root[data-theme='dark']`, and `prefers-color-scheme: dark` with `:root:not([data-theme='light'])`)
| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` / `--surface` / `--card` | #fff / #f5f3ef / #fff | #0d1110 / #111614 / #171d1b | page / lane and panel fill / cards |
| `--ink` `--muted` `--subtle` | #0e0f0f #545b57 #5f6662 | #eceeed #a3ada8 #939d98 | text, secondary, tertiary (`--subtle` is AA on every surface) |
| `--control-border` | #7a807c | #6c7973 | borders of inputs, selects, textareas (3:1 on every surface); `--line-strong` stays decorative |
| `--control-h` | 40px | 40px | THE height of every input, select (`select-trigger`), date/colour picker (`picker-trigger`) and `.input`; 44px under a coarse pointer. Controls side by side are ALWAYS the same height: never hard-code 32/36/40/44px on one control. A deliberately compact row sets one shared height on all of its controls together |
| `--line` `--line-strong` `--hover` | #e3e1da #cfccc3 #f0eee8 | #27302d #3a4541 #1e2623 | borders, hover fill |
| `--accent` `-hover` `-ink` `-soft` `-text` | #0f6b4f (green), #0b5640, #fff, #d6ebdd, #0b5640 | #4cc08f, #6bd0a5, #04140d, #163a2c, #7fd1ae | the brand; rebrand here only |
| `--success` `--warning` `--danger` `--info` (+ `-soft`) | status pairs | lighter pairs | status, always with an icon or text |
- Elevation: `--shadow-sm|md|lg` (lighter ink in light, near-black in dark), `--overlay` scrim. At rest nothing has a shadow; hover is `sm`; dragging and overlays are `lg`.
- Lane color is any hex, applied as `color-mix(in oklab, var(--lane) 10%, var(--surface))`. Label text color is computed for contrast (`tests/contrast.test.ts`).

## 3. Light and dark
Light is the default. `data-theme="light|dark"` on `<html>` forces one; no attribute follows the device. The key is `site:theme` in localStorage, set before first paint by `src/layouts/App.astro` and changed in Settings, Appearance (`src/app/settings/prefs.ts`). High contrast, accent presets, font scale, radius and reduce-motion (SPEC §12) are NOT built yet: only mode and board density are.

## 4. Type
- Family: `--font-sans` = Inter, then system UI stack; `--font-display` = the same; `--font-mono` = system mono. Body 16 px / 1.6 (`global.css`).
- Scale as used: page title (`.app-title`) 1 rem semibold in the top bar; screen titles clamp 22 to 30 px on the website; app body 14 to 15 px; lane title 13 px semibold; card title 14 px; meta, counts and badges 11 to 13 px.
- **OPEN DECISION:** SPEC §11 names Plus Jakarta Sans (self-hosted woff2, at most 2 weights). `global.css` still uses Inter (not self-hosted either: it falls through to the system stack unless installed). Decide: keep Inter/system, or add Plus Jakarta Sans and change `--font-sans`. Not changed here.
- Per language (`i18n.css`, class `lang-xx` on `<html>`): system stacks first, with lazy `@font-face` Noto subsets for bn, hi, ar/fa, ur (Nastaliq), th, zh, ja, ko, fetched only while that language is active (files go in `public/fonts/`; until present the system stack shows). Line height 1.6 for scripts that need it, 1.9 for `ur`.

## 5. Shape and spacing
- Radius: `--radius-sm` 8, `--radius` 12, `--radius-lg` 16; lane 12, card 10, tiles `--radius`.
- Lane 288 px wide, 12 px gap (board scrolls horizontally with scroll-snap), lane body padding 4/8 px, card gap 8 px, card padding 8/10 px.
- Content: `.app-content` max 1240 px, padding 1.75 / 1.5 / 3 rem; `.lf-content` is full width for boards. Forms are `.lf-form` (grid, 1 rem gap), actions end-aligned.
- Density (Settings, Appearance; `data-density` on `<html>`): compact = 4 px card gap, 4/8 px card padding; comfortable (default) = as above; spacious = 12 px gap, 12/14 px padding.
- Touch targets 44 px on phones (`.lf-dock-link` min 64x44). Under 960 px the sidebar becomes a drawer with a scrim and a floating bottom dock appears; lanes become 85 vw. Under 560 px the top bar keeps only menu, title, bell, search and avatar, and the floating board toolbar shows icons only. Chat shows list and conversation side by side from 721 px.

## 6. Motion
- 150 ms ease-out for hover, press and color changes (`transition: ... 0.15s ease`), shimmer skeletons (1.4 s) while loading, a 2-degree tilt and `shadow-lg` on the dragged card, a drop-indicator line. No decorative motion.
- `prefers-reduced-motion: reduce` turns transitions and the shimmer off (`app.css`, `src/app/app.css`). `html[data-motion='reduce']` is honoured in `src/styles/a11y.css` (the switch UI is not built yet). `a11y.css` also holds the 44 px coarse-pointer targets.

## 7. Language and direction
`applyDocumentLocale()` sets `<html lang dir class="lang-xx">`. RTL (ar, ur, fa) uses logical properties everywhere (`margin-inline-*`, `inset-inline-*`, `text-align: start`); `input[type=email|url|tel|number]`, `code`, `kbd` stay LTR in RTL. Mirror directional icons. Board horizontal scroll and drag in RTL need a manual check (Phase 9b).

## 8. Signature elements (as built)
Soft tinted lane with color dot, name, count pill and WIP meter; bordered card with title first; workspace switcher in the sidebar (initials tile); floating bottom dock on phones; undo toast at the bottom center; type-only wordmark (site name and an initials mark when there is no logo); empty states with an icon, one sentence and one action.

## 9. Not yet built or decided
Plus Jakarta Sans vs Inter; high-contrast mode; accent presets and custom accent; workspace brand accent and enforce; font scale, radius and reduce-motion switches; board backgrounds scrim check; card slide-over panel look (Phase 2).
