# RTL and script audit (ar, ur, fa; th, zh, ja, ko fonts)

Review only, static read. Nothing was run in a browser and no source was edited. Scope: `src/app/**`, `src/styles/app.css`, `global.css`, plus `i18n.css`, `i18n-cjk.css` and the kit files `src/portal/ui/overlay.tsx`, `popover.tsx` that `/app` uses.

Overall: the CSS is already mostly logical. There are no `margin-left`, `padding-right`, `text-align: left`, `float` or `left:`/`right:` declarations in `src/app/**/*.css`, `app.css` or `global.css`. The remaining problems are physical shorthands, un-mirrored icons, one physical-positioned menu, `letter-spacing` on cursive scripts, and Nastaliq line height.

## Must fix

1. **Lane collapse chevron points the wrong way in RTL.** `src/app/boards/lane.tsx:143` uses `'chevron-right'` for "collapsed", with no `icon-flip`. `IconButton` takes a name only (`Icon` at `src/portal/ui/icon.tsx:489` accepts `className`, but `IconButton` has no flip option). Fix: let `Icon`/`IconButton` add `icon-flip` automatically for a directional set (`chevron-left/right`, `arrow-left/right`, `corner-*`), or pass `className="icon-flip"`. The `.icon-flip:dir(rtl)` rule is at `app.css:2399`.
2. **Image viewer prev/next icons are not mirrored.** `src/app/cards/attachments.tsx:165-166` uses `arrow-left` for previous and `arrow-right` for next. The keyboard handler at `:148-150` already swaps ArrowLeft/ArrowRight in RTL, so keys and icons disagree. Fix: swap the icon names when `dir === 'rtl'`, or apply `icon-flip` to both.
3. **Calendar prev/next chevrons are not mirrored.** `src/app/boards/views/calendar-view.tsx:107-108` uses `chevron-left` for prev and `chevron-right` for next, with no flip. The date picker in `popover.tsx:313,319` does this correctly, so reuse that pattern.
4. **Menu placement ignores RTL.** `src/portal/ui/overlay.tsx:406`: `align === 'end' ? rect.right - menu.offsetWidth : rect.left`. In RTL "end" is the left edge, so row and user menus open on the wrong side of their trigger. They are clamped to the viewport, but they are misaligned. `popover.tsx:57` already branches on `rtl`. Fix: mirror that branch (`const rtl = getComputedStyle(button).direction === 'rtl'`, then swap the two edges).
5. **`letter-spacing` on Arabic-script text.** The `.app-shell` root sets `letter-spacing: -0.006em` (`src/app/design.css:12`), and more rules set it: `:35` brand, `:45` nav label (+0.04em), `:80` title, `:167` lane name, `:220` card title, `:292` card dialog title, `:304` `.btn`, `chat.css:43` section label (plus uppercase), and `global.css:225,288` (`.eyebrow` 0.12em uppercase). Any non-zero tracking breaks letter joining in ar/fa/ur and degrades Nastaliq. Fix in `i18n.css`:
   ```css
   html[dir='rtl'] *, html.lang-th *, html.lang-hi *, html.lang-bn * { letter-spacing: 0 !important; text-transform: none; }
   ```
   Prefer `html:lang(ar) .app-shell, html:lang(fa) ..., html:lang(ur) ...` and reset the specific selectors above instead of `!important` if the specificity is manageable.
6. **Nastaliq (ur) is clipped by fixed line heights.** `i18n.css` sets `line-height: 1.9` only on `body`. `src/app/design.css` and the other app CSS files set 13 explicit `line-height` values on titles, card text, buttons and badges, and `min-height` boxes. Nastaliq has tall ascenders and deep descenders, so these will clip. Fix: add `html.lang-ur .app-shell :is(.lf-card-title, .lf-lane-name, .btn, .lf-label, .badge, .app-nav-link, input, select, textarea) { line-height: 1.9; }`, and check chips and badges for fixed `block-size`.

## Should fix (physical four-value shorthands that do not flip)

These are padding for an icon or chevron on one side, so in RTL the space ends up on the wrong side.

| File:line | Declaration | Fix |
| --- | --- | --- |
| `src/styles/app.css:1356` | `.toolbar .select select { padding: .5rem 2.25rem .5rem .75rem }` (chevron room on the right) | `padding-block: .5rem; padding-inline: .75rem 2.25rem` |
| `src/styles/app.css:1382` | `.search-input input { padding: .5rem .75rem .5rem 2.25rem }` (icon at `inset-inline-start`, `:1372`) | `padding-inline: 2.25rem .75rem` |
| `src/styles/app.css:1903` | `.toast { padding: .625rem .5rem .625rem .875rem }` | `padding-block: .625rem; padding-inline: .875rem .5rem` |
| `src/app/design.css:161` | `.lf-lane-head { padding: .625rem .5rem .375rem .75rem }` | `padding-block: .625rem .375rem; padding-inline: .75rem .5rem` |
| `src/styles/app.css:527, 2146` | `border-radius: 0 0 var(--radius) var(--radius)` | Symmetric, so fine; no change |

Also: `app.css:1509-1513` (switch thumb, `translateX(16px)` with an RTL override) and `app.css:299-308` (sidebar off-canvas, with an RTL override) are correct as written. `app.css:1829-1830` (`--slide-from: -24px` for the drawer in RTL) is also correct. `app.css:1874` is fine because it reads the variable. `.app-sidebar` uses `inset-inline: 0 auto`, which is logical.

## Drag and drop (dnd-kit 6.3.1, sortable 10.0.0), `src/app/boards/canvas.tsx`

- **Pointer drag: OK.** `horizontalListSortingStrategy` (`canvas.tsx:243`) and `CSS.Transform.toString` (`lane.tsx:109`, `card.tsx:145`) work on measured rects, which are physical, so lanes drag to the visible position in RTL.
- **Drop index: OK.** The order in the array is DOM order, which flips visually in RTL, so lane 1 appears on the right. That is the expected RTL behaviour.
- **Keyboard drag (`KeyboardSensor` + `sortableKeyboardCoordinates`, `:76`)**: ArrowRight moves toward the visual right, which in RTL is toward earlier lanes. This is physical-direction correct, but the instruction string `dnd.instructions` says only "arrow keys", so no text fix is needed. Check manually that ArrowRight in an RTL lane moves to the lane on the visual right.
- **Auto-scroll risk.** The board container (`app.css:165-168`) is `overflow-x: auto` with `scroll-snap-type: x proximity`. In RTL, Chrome and Firefox report negative `scrollLeft`. dnd-kit 6.3's `autoScroll` has had RTL edge-detection issues, so the edge-zone scroll may not trigger on the correct side. Manual check in Phase 9b: drag a card toward the visual left edge of a board wider than the viewport. If it fails, pass `autoScroll={{ threshold: { x: 0.15, y: 0.2 } }}` and test; the fallback is a small custom scroller using `scrollBy({left: ±n})`, which is physical-safe.
- **Drag overlay tilt**: `app/app.css:295` has `rotate(2deg)`. It is a mirror-neutral cosmetic and acceptable.
- **Calendar view drag** (`calendar-view.tsx:26`) uses `CSS.Translate` on the pointer, so there is no RTL issue. The week grid order (Sunday first or Saturday first for ar/fa/ur) should come from `Intl.Locale.weekInfo`; check `calendar-view.tsx` and `popover.tsx:248-252`.

## Numbers, kbd, bidi

- `kbd` and `input[type=email|url|tel|number]` are forced `direction: ltr` in `i18n.css:81-87`, and `Kbd` (`shortcuts.tsx:24`) and `editor-toolbar.tsx:248` set `dir="ltr"`. `.lf-kbd` is `inline-block`, so it isolates itself. OK.
- `lf-kbd-hint` in `shell.tsx:264` contains `/`. Fine inside `dir="ltr"` `Kbd`.
- **Latin words inside translated sentences** (`i18n-qa.md` section 8, 17/15/18 strings per language): `card.addHint`, `dnd.instructions`, `members.copyFailed`, `members.emailInvalid`, `cd.linkInvalid`, `cd.commentPlaceholder`, `chat.suggestionsHint`, `chat.creatingGeneral`. Wrap these via the `t()` helper's rich-text path, or at the call site, with `<bdi dir="ltr">`; for placeholders (`cd.commentPlaceholder`, `members.emailInvalid`) the input itself is ltr, but the helper text is not. A generic `tb(string)` that wraps `/[A-Za-z][A-Za-z0-9+@#:/._-]*/` runs in `<bdi dir="ltr">` solves all of them. Only 2 spots already use `<bdi>`: `conversation-view.tsx:359`, `chat-screen.tsx:21`.
- **User-generated text** (card titles `card.title` at `calendar-view.tsx:28`, lane names, member names, chat bodies, comment bodies) has no `dir="auto"`, so a mixed-language title can place punctuation wrongly. Fix: add `dir="auto"` on these text nodes and on `textarea`/`input` elements for titles, comments, chat composer. Use `<bdi>` where the text sits inside a UI sentence, for example mentions.
- Numeric digits: `bytesLabel` uses a `format` callback; confirm it goes through `Intl.NumberFormat(locale)`. For `ar` choose the numbering system deliberately (`ar-u-nu-latn` or `arab`) and keep it consistent across counts, dates and WIP meters. `ur`, `fa` default to Latin or Extended Arabic-Indic digits depending on the runtime, so test one.
- Progress bars and meters (`.lf-meter`, checklist progress, WIP) fill from the inline start by default for `<progress>`/`<meter>`. Any custom bar that uses `width: n%` is fine, but one using `transform-origin: left` or `scaleX` would not be; no match found in a grep, so OK.

## Fonts

Fallback stacks live in `i18n.css:34-41`, applied by `html.lang-xx { --font-sans: ... }`.

- **Works**: ar and fa share `LF Noto Arabic`; ur uses `LF Noto Nastaliq`; th uses `LF Noto Thai`; zh/ja/ko use sliced Noto Sans files in `public/fonts/`. All files exist.
- **Gap 1: `--font-display` and form controls.** `global.css:58` sets `--font-display: var(--font-sans)`. A custom property that references another is resolved where it is declared (on `:root`), so the later `html.lang-ur { --font-sans: ... }` override does NOT reach `--font-display`. Every rule using `font-family: var(--font-display)` (`app.css:29, 668`, `global.css:337`, `home.css:25, 117`, `app/design.css` titles) stays Inter in all languages. Latin fallback means Arabic, Thai and CJK glyphs in titles fall to the browser default rather than Noto. Fix in `i18n.css`: in each `html.lang-xx` rule add `--font-display: var(--font-xx);` (or declare `--font-display` on `html` instead of `:root` so it re-resolves).
- **Gap 2: Urdu fallback order.** `--font-ur` goes `Nastaliq`, `Jameel Noori Nastaleeq`, `Noto Sans Arabic`, `Segoe UI`, `Tahoma`, then Inter. If the Nastaliq subset fails to load, Latin Inter wins for digits and English words (good), but there is no `LF Noto Arabic` in the chain; add `'LF Noto Arabic'` before `'Noto Sans Arabic'`. Also confirm `noto-nastaliq-urdu.woff2` contains Latin digits and punctuation, otherwise they take the Arabic fallback and look mismatched.
- **Gap 3: Thai.** Line height 1.6 is applied (`i18n.css:55-58`), and it is not set for `ar`/`fa`/`zh`/`ja`/`ko` (default 1.6 on body, fine). Thai has no spaces: `overflow-wrap: anywhere` is set only on some selectors (`app/app.css:118,219,318`, `phase3.css:40,45`, `responsive.css:33,68`). Add `html.lang-th, html.lang-zh, html.lang-ja { word-break: normal; line-break: strict; }` and use `overflow-wrap: anywhere` on `.lf-card-title`, `.lf-lane-name`, comments and chat bodies. Browsers do dictionary segmentation for Thai only when `lang="th"` is on the element: `applyDocumentLocale()` sets `lang` on `<html>`, so fine, but `lang` must also be present on the app shell's content if it is mounted in a different subtree (it is `data-locale` + `dir` only at `shell.tsx:225`; add `lang={locale}` there).
- **Gap 4: CJK.** For ja and zh the same `font-family` is used for UI at 11-13 px; Noto Sans at 11 px is dense, so consider `html:lang(ja|zh|ko) { --meta-size: 12px }` or a min of 12 px for badges and counts. CJK has no italics and no uppercase: `text-transform: uppercase` and `font-style: italic` are harmless. Mark `lang` on user text from other languages if known (not required).
- **Gap 5: bold weights.** Arabic and Thai Noto are loaded for weights 400-600 only (`@font-face` `font-weight: 400 600`), but Nastaliq 400-700. Rules using `font-weight: 700` in Arabic or Thai will be synthesised bold or clamped; check `.app-title`, `.btn` and headings use 600 at most.
- `Georgia` on `.article .prose` (`global.css:1281`) is the website blog only, not `/app`.

## Verified correct (no change)

- `html[dir='rtl'] { text-align: start }`, `input[type=email|url|tel|number]`, `code`, `kbd` forced LTR.
- `.drawer:dir(rtl)` slide direction, `.app-sidebar:dir(rtl)` off-canvas, `.switch-thumb:dir(rtl)`.
- `.select-chevron` and `.search-input .icon` use `inset-inline-*`; `.lf-fb-pop` uses `inset-inline-start`.
- Scroll snap uses `start`, which is logical.
- Board `flex` row reverses automatically under `dir=rtl` on the shell (`shell.tsx:225`).
- `AccentPicker` (`settings/appearance.tsx:46-48`) and the image viewer (`attachments.tsx:148-150`) swap arrow keys correctly.
- `.cd-grid` is a two-column grid, so panes swap sides in RTL. The CSS comment at `cards.css:143` says "left/right" and is only a comment, but the order (details, then comments) will become right then left, matching a normal RTL reading order.

## Suggested order

1. Items 1-4 (mirroring and menu placement): small, visible, in the first minute of an RTL demo.
2. Items 5-6 (`letter-spacing`, Nastaliq line height): one CSS block in `i18n.css`.
3. Padding shorthands table.
4. `--font-display` fix and `lang={locale}` on the shell.
5. `<bdi dir="ltr">` helper for Latin runs and `dir="auto"` on user text.
6. Manual drag check in an ar board: pointer drag across lanes, keyboard drag, and auto-scroll near the visual left edge.

## 2026-11-03 CSS pass (logical properties)

Fixed (CSS only, LTR output identical):
- `src/styles/app.css`: `.toolbar .select select`, `.search-input input`, `.toast` four-value padding now `padding-block` + `padding-inline`.
- `src/app/design.css`: `.lf-lane-head` padding now logical.
- `src/styles/home.css`: `.home-faq details p` padding now logical (`padding-inline: 4px 40px`).

Checked, no change needed: `translateX` uses (`app.css` sidebar, switch thumb and drawer already have `:dir(rtl)` or `--slide-from` overrides; `home.css` `.home-more` has an RTL override), shimmer `background-position` (symmetric, decorative), `border-radius: 0 0 r r` (symmetric), `.spinner` `border-right-color` (rotates, no visible effect), `global.css` `background-position: center`. No `margin/padding/border-left|right`, `left/right:`, `text-align:left|right` or `float` remain in `src/**/*.css`.

Left (needs TSX or JS, out of CSS-only scope): Must fix items 1-4 (lane chevron, image viewer arrows, calendar chevrons need `icon-flip`; `overlay.tsx` menu placement), items 5-6 (letter-spacing and Nastaliq line height in `i18n.css`), font and bdi items.

Needs browser: dnd-kit auto-scroll at the visual left edge in RTL, keyboard drag direction, drawer slide-in and sidebar off-canvas direction, FAQ and toolbar padding look in ar/ur/fa.

## 2026-11-03 TSX pass (icons, menu side, bidi text)

Fixed (LTR output identical; no build or browser run):
- Directional icons: `Icon` in `src/portal/ui/icon.tsx` now adds `icon-flip` itself for `arrow-left`, `arrow-right`, `chevron-left`, `chevron-right` and `log-out` (the existing `.icon-flip:dir(rtl)` rule in `app.css` does the mirroring; an explicit `icon-flip` is not doubled). This covers the lane collapse chevron, image viewer prev/next, calendar prev/next, back arrows, "move" and "send" arrows, and overview links. Undo and redo are text buttons, not icons.
- Menu placement: `Menu` in `src/portal/ui/overlay.tsx` resolves `align` 'start'/'end' against the computed direction (same approach `popover.tsx` already had, which needed no change).
- User text: `dir="auto"` on card titles (board card, table view, calendar chip), lane names, board names, archive and saved-filter titles, chat bodies (incl. pending), and `Person` names; `<bdi>` on mentions, message authors, workspace switcher name and viewer name.

Left: member and author names rendered in places outside the above (for example `AvatarStack` labels, `Checkbox` labels with names, select option labels, toasts and aria strings built with `t()` params); `<bdi>` for Latin runs inside translated strings (needs the `tb()` helper idea above); `dir="auto"` on title and comment inputs and the chat composer.

Needs browser: mirrored arrows look right in ar/ur/fa (esp. the chat send arrow, which is `arrow-right` and now points left), menu opens on the correct edge near the viewport edge, mixed Arabic/Latin card titles.

## 2026-11-03 Leftovers pass (bidi text)

- `dir="auto"` added on user-text fields: card title input and description textarea (`card-panel.tsx`), card and lane composers (`boards/composers.tsx`), lane name (`boards/dialogs.tsx`), board name (`boards/board-settings.tsx`), chat composer and chat message edit box. LTR/English output identical.
- `<bdi>` on participant names in the new-conversation checkboxes (`chat/new-conversation.tsx`).
- Skipped: `AvatarStack` (names only appear in `title` / `aria-label` attributes, no text node to wrap); select option labels (`<option>` cannot contain `<bdi>`); the checklist item Checkbox (`cards/checklists.tsx`, owned by another agent) and comment textarea (`cards/comments.tsx`, same).
- `lang={locale}` on the shell subtree: not needed. `applyDocumentLocale()` (`src/i18n/index.tsx`) sets `html lang` and `dir` on every locale change, so it is redundant.
- 12px CJK minimum: done in `src/styles/i18n-cjk.css` (see i18n-qa typography section follow-up). Needs browser check in zh/ja/ko for nav label, dock and card label fit.

## 2026-11-04 Verification pass (must-fix 1-6)

All of must-fix 1-6 are now in the code, confirmed by reading the files:
- 1-3 (chevron and arrow mirroring): `Icon` adds `icon-flip` for the directional names (TSX pass above).
- 4 (menu placement in RTL): `overlay.tsx` resolves start/end by computed direction (TSX pass above).
- 5 (letter-spacing): `i18n.css` resets tracking (and uppercase) for `:lang()` ar, ur, fa, th, hi, bn, zh, ja, ko, with `!important` because the rules to beat are single-class selectors.
- 6 (Nastaliq line height): `i18n.css` sets `line-height: 1.9` on headings, text, controls, card/lane/nav/badge/toast classes and `[class*='title']` under `html:lang(ur)`; Thai/Hindi/Bengali get 1.6 on compact classes.
- Gaps 1, 2 and 3 (`--font-display` re-resolved on `html[class*='lang-']`, `LF Noto Arabic` in the Urdu chain, line-break rules for th/zh/ja/ko) are also in `i18n.css`.

Still open: gap 5 (`font-weight: 700` in Arabic and Thai, files cover 400-600 only; browser synthesises or clamps, cosmetic), fixed `block-size` on chips and badges in Urdu (needs browser check), `<bdi>` helper for Latin runs inside translated strings, and the browser checks listed above.
