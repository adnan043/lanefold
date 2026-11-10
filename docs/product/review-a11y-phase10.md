# Accessibility pass, Phase 10 (static, 2026-11-04)

Scope: `src/app/**`, `src/portal/**` by code reading, on top of `reviews/a11y-audit*.md`, `rtl-audit.md`, `responsive-audit.md`. Skipped: custom-fields, dependencies, recurrence, templates, flows (being built by others).

## Fixed
1. `Field` (`src/portal/ui/form.tsx`) now wires an unwired control itself: sets `id` (so the label names it), `aria-invalid` and `aria-describedby` to the error or hint. Controls wired by `form.field()` keep their own. Before, `<Field id error><input value=...></Field>` had a label that named nothing and an error that was not linked.
2. Field's "(optional)" suffix and was English-only in `/app`: now `UiLabels.optional` (`labels.tsx`), fed from the existing `common.optional` catalog key in `src/app/shell.tsx` (all 20 catalogs already have it; no new strings).
3. New guard `tests/a11y-guard.test.ts`: icon-only buttons are named, `_blank` links have `rel`, images have `alt`, no `window.alert/confirm/prompt`, no positive `tabIndex`, Field wiring, toasts (alert/assertive for errors, status/polite otherwise), dialogs are native `showModal()`.

## Verified in code, no change needed
- Dialog/Drawer/Modal/palette: native `<dialog>` + `showModal()` (trap, Esc, focus return); Menus/Select/Tabs arrow keys; popovers return focus.
- Toasts: polite status region and assertive alert region; auto-dismiss pauses on hover and focus.
- Icon-only buttons: scan of every `<button>` in app + portal found none unnamed; `IconButton` requires `label`.
- Board dnd alternative: card menu "Move to..." (lane and position) exists, plus dnd-kit keyboard sensor and announcements.
- Reduced motion (`a11y.css` global + `data-motion`), forced colors, 44 px coarse-pointer targets, focus rings (`outline: none` only on `tabindex=-1` focus targets: `.app-title`, `.cd-dialog`).
- Heading order: one `<h1>` in the shell; screens use `h2`, sections `h3`/`h4`.
- Colour tokens: `tests/contrast.test.ts` checks global.css tokens (light, dark) and accent presets.
- Filter search input is inside a `<label>`; Group-by select is inside a `<label>`.

## Remaining
- `src/app/cards/fields.tsx` (custom fields, owned by another agent): inputs at lines ~144, 239, 246 sit in `Field` without an id; fixed by the `Field` change above, but re-check after that agent finishes (and `Select`/`aria-invalid` pass-through).
- `PasswordInput` / `PasswordChecks` strings ("Show password", "(done)") are English; used only in the English-only `/dashboard` portal.
- Phone nav drawer has no true focus trap/inert (see a11y-audit-3).
- Needs a browser or screen reader: focus order and announcements of toasts, onboarding step announcement, sticky bars over focused elements (2.4.11), 320 px reflow and 400% zoom, touch/keyboard drag in RTL, contrast of the accent check mark on every accent, `.lf-pri`/`.lf-grip` targets on a device.
