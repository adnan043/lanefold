# Bundle review (static read of `dist/client/`, nothing rebuilt)

Sizes are raw / gzip in KB. Measured on the existing build (before the CSS change below).

## Biggest client files
| File | Raw | Gzip | What |
| --- | --- | --- | --- |
| `nav.*.css` | 255 | 82 | `i18n.css` + `i18n-cjk.css`: 348 `@font-face` slices for zh/ja/ko (was eager on `/app`) |
| `client.*.js` | 204 | 63 | react-dom |
| `board-screen.*.js` | 102 | 31 | board + dnd-kit (lazy route) |
| `ui.*.js` | 94 | 30 | TanStack router/query core |
| `bn/hi/th/ru/ur/fa/ar/ja/ko...js` | 57-99 | 16-21 | one catalog per language (20 total, lazy) |
| `App.*.css` | 52 | 10 | app styles (design/responsive/tables/app css) |
| `card-panel.js` / `.css` | 43 / 13 | 12 / 3 | lazy |
| `shared.js`, `conversation-view.js` | 33 / 30 | 11 / 10 | shared, chat (lazy) |
| `Base.css`, `forced-colors.css`, `index.css` | 25 / 25 / 9 | 6 / 6 / 2 | public site |

## What `/app` loads
- Eager (host page `client:only` AppRoot, static import graph): about 270 KB raw / 92 KB gz of app chunks plus react-dom
  (204 / 63), so roughly 475 KB raw / ~155 KB gz JS, plus `App.css` (10 gz) and, before the fix, `nav.css` (82 gz).
  The `en` catalog (56 / 16) is in that graph by design (source of the typed keys).
- Lazy, verified by the `AppRoot` dynamic imports: every route screen (board-list, board-screen, card-panel, my-day, inbox,
  chat, members, join, onboarding, 6 settings screens), command palette (`palette.js`, 5.7 KB gz in shell via
  `lazyWithRetry`), shortcuts dialog, notifications panel, board chat (`lazy()` in board-screen).
- dnd-kit is only in `board-screen` (not in the entry). Markdown (`markdown.js`, 5.8 KB) is a tiny shared chunk; no markdown
  library bloat. No charts library exists (none in package.json, none in dist). Dashboard screens (`src/portal`) are a
  separate entry (`PortalApp`, 3.9 KB gz + shared) and not loaded by `/app`.
- i18n: `import.meta.glob('./messages/*.json')` (lazy) gives one chunk per locale; only `en` (bundled) plus the active
  locale are fetched. Confirmed: no other locale chunk is statically imported.

## Public pages
- Home/about/pricing/blog: JS is only `ClientRouter` (5 gz), `Base` script (1 gz), `page.js` (47 bytes). CSS: `index` 2 + `Base` 6 gz.
  Very light; no hydration islands.

## Fonts and images
- `public/fonts`: 15 MB on disk (Noto JP 5.5, KR 3.6, SC 4.5, Urdu 236 KB, Arabic 164, Devanagari 120, Bengali 108, Thai 27),
  but all are `font-display: swap` and unicode-range sliced; a browser fetches a file only when the active `lang-xx`
  font stack matches text on the page. Default (en) loads zero web fonts (system stack). No preload hints, correct: preloading
  would force downloads for every visitor.
- `public/images`: one 18 KB OG png. Icons 2-8 KB. Nothing to optimise.

## Change made
- `src/styles/i18n.css` no longer `@import`s `i18n-cjk.css`; `src/i18n/index.tsx` imports it dynamically
  (`import('../styles/i18n-cjk.css')`) only when the locale is zh, ja or ko. Saves 82 KB gz (255 KB raw) of render-blocking CSS
  for the other 17 locales. For zh/ja/ko the rules arrive one tick after the first paint, with `font-display: swap`
  fonts anyway, so the visible result is the same. `tests/i18n-fonts.test.ts` now lists the CJK file explicitly
  (it used to follow the `@import`).
- Needs a rebuild to confirm that Vite emits the CSS as its own async chunk (not run, per instructions).

## Recommendations (not done)
1. The 20 non-en catalogs are 16-21 KB gz each; fine since they are lazy. Could drop unused keys per locale, low value.
2. Eager `/app` graph ~155 KB gz JS is acceptable; if it needs trimming, split `workspace.js`/`queries` first.
3. `public/_headers` already caches `/fonts/*` for a year; nothing to do.
4. Re-measure after the next build: `nav.*.css` should drop to about 3 KB and a new async `i18n-cjk.*.css` should appear.
