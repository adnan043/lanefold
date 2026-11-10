# Accessibility, RTL and responsive audit, round 3 (static, 2026-11-04)

Scope: `src/app/` except the files being built now (custom fields, dependency badges, recurring/templates, flows, saved filters, share link). Rounds 1-2, the RTL audit and the responsive audit were re-read first; nothing below repeats a fixed item.

## Fixed in this pass
1. Phone nav drawer (`src/app/shell.tsx`): opening it left focus on the menu button behind the scrim, so Tab walked the page, not the drawer. Focus now moves to the first nav link on phones (max-width 960px), and Esc returns it to the menu button.
2. Touch targets (`src/app/responsive.css`): under `pointer: coarse` the app's own controls were below 44 px: sidebar nav links (32), rail toggle (26), filter options (36), lane-menu items (36), card Close (24), editor toolbar buttons (32), chat message actions. They now have a 44 px minimum (`min-inline-size` reset to 0 for the row-like ones).
3. Guard tests (`tests/rtl-contract.test.ts`): no physical `left/right` properties in 15 app CSS files, the coarse-pointer 44 px block, the reduced-motion rule, and the drawer focus handoff.

## Checked, fine
- Physical properties: no `margin/padding/border-left|right`, `left:`/`right:`, `text-align:left|right`, `float` or `translateX` left in `src/app/**/*.css` (accents.css excluded from the guard; no hits either).
- Reduced motion: global `prefers-reduced-motion` and `html[data-motion='reduce']` rules in `src/styles/a11y.css` cover animations, transitions, smooth scroll and lane snap; the drag overlay and rail have their own rules.
- Drawer RTL: `.app-sidebar:dir(rtl)` flips the slide-in; closed drawer is `visibility: hidden`, so it is out of tab order.
- Live regions: board undo (`role=status`), filter results, shortcuts and shell status, import progress, calendar month; errors use `role=alert`. Dialogs use the native `<dialog>` Modal (trap, Esc, focus return).

## Open (needs a browser or a decision)
- No real focus trap or `inert` on the phone drawer: Tab can still leave it forward into the page. Making `.app-main` inert would block the menu button, which is in it; needs a restructure of the topbar. Low-Med.
- `.lf-pri` (20 px) and `.lf-grip` stay under 44 px on touch: enlarging them changes card layout; they have the 24 px minimum (WCAG 2.5.8) from `boards/a11y.css`. Check on a device.
- `design.css:48` etc. (32 px nav link) is fine on mouse, covered now for touch.
- Not touched by design: custom fields, dependency badges, recurring/template UI, flows, saved filters, share link. They should be re-audited when they land (targets, `aria-*` on menus, logical CSS; the new guard test covers only the listed CSS files, add new CSS files to its list).
- Still browser only: drag and drop with touch/keyboard in RTL, forced-colors, contrast of the check on every accent.
