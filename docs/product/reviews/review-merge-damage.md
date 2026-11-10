# Merge-damage audit (read-only)

Scope: duplicates, truncated handlers, dead code, cross-agent fit, contradicting comments. Scripts live in the session scratchpad.
Result: no second boards.ts-class casualty found. Server routes and every `$transaction` result are intact.

## Clean (checked)
- No duplicate top-level function/const/class/type names in any non-generated .ts/.tsx.
- No duplicate method+path across routes mounted on `/` (boards, board-extras, card-detail, chat, chat-extras, billing, members, workspace-settings, notifications, search). Only `/` collisions are on distinct prefixes (/site, /checkout, /jobs).
- Every `$transaction` (about 30 sites in boards, board-extras, card-detail, chat, chat-extras, members, search, workspace-settings) returns or throws on all paths and every result is narrowed before use. search.ts triage has the full LaneFull/stale tail.
- Every route handler ends in a response (apart from regex false positives that are helper-delegating one-liners).
- All named relative imports resolve to a real export, including the split `portal/ui` barrel (no import of a removed Popover/DatePicker/Chip/CommandPalette symbol remains).
- All client `call(...)` paths have a server route. All `lazyRouteComponent` targets exist.
- Every `problem('code')` has an `errors.<code>` string in en.json. No duplicate JSON keys in any locale. Plural-suffix differences (_few/_many/_zero) are intentional per-language.

## Findings
1. SUSPECTED, src/app/responsive.css:7-10 vs src/app/cards/cards.css:7-13. Both define `.cd-panel` at equal specificity. responsive.css says it is "loaded after app.css, so it wins ties" and its z-index table puts the card sheet at 28, below the nav scrim at 30. cards.css (imported by card-panel.tsx, so bundled later or lazily) sets z-index 30. If cards.css loads last, the card sheet ties with the scrim and the comment is false. Same pattern: `.lf-undo-region` z-index (responsive.css:10 vs app.css:442), the `@media (max-width:960px)` `.lf-dock`, `.lf-lane`, `.lf-undo-region` blocks (responsive.css:52-70 vs app.css:467-499) and `.chat-layout` padding-block-end (responsive.css:76 vs chat.css:502). Consequence: mobile fixes silently lost depending on chunk order. Fix: raise specificity (`.app-root .cd-panel`) or move the overrides into the component files; verify in the built CSS order.
2. CONFIRMED (dead file), src/app/screens.tsx (4 lines). Only unused imports (`useT`, `EmptyState`, `PageHeader`), exports nothing, imported nowhere; comment says chat is a later phase, which is false. Fix: delete.
3. CONFIRMED (dead code), src/app/boards/dialogs.tsx:37 `EditCardDialog` (about 65 lines) and :169 `BoardSettingsDialog` (about 60 lines). Unreferenced anywhere (superseded by card-panel.tsx and board-settings.tsx). Only `EditLaneDialog` is used. Fix: delete both and their now-unused imports.
4. CONFIRMED (minor), src/app/boards/board-screen.tsx:6 imports `LoadingBlock` and never uses it.
5. SUSPECTED (minor), src/server/routes/chat.ts reactions DELETE (about line 895-905) has no `a.canWrite` check, while PUT reactions has one. A read-only or archived-board viewer can remove their own reaction. Fix: mirror the PUT guard.
6. CONFIRMED (low), `src/app/cards/cards.css` vs `src/app/cards/a11y.css` `.cd-resize` (10px vs 24px, -5px vs -12px) and `.lf-grip` touch-action (app.css:262 vs a11y.css:8 vs responsive.css:34/39). These are intentional overrides that depend on the same import-order assumption as finding 1.
7. CONFIRMED (low), unused exports (no importer anywhere): server/entitlements.ts `APP_CONFIG_KEY`; server/permissions.ts `Codename`; server/jobs/logic.ts `shouldFallToFree`; i18n/meta.ts `needsReview`; i18n/resolve.ts `parseAcceptLanguage`; i18n/core.ts `PLURAL_SUFFIXES`, `TFunction`; lib/seo.ts `DEFAULT_SOCIAL_IMAGE`, `jsonLdText`, `siteJsonLd`, `postJsonLd`, `jobJsonLd` (may be used from .astro: not scanned, verify before deleting); lib/account.ts `nextPath`, `takeToken`, `replaceWithMessage`; lib/format.ts `formatMoney`; lib/posts.ts `readingMinutes`.
8. SUSPECTED (low), about 187 en.json keys are not referenced literally in src (many are dynamic `errors.*`, `appearance.*`, `bx.grad.*`). Real orphans are plausible (e.g. `shortcuts.sheet`, `nav.skipToContent`, `card.saved`, `nav.card`, `myDay.description`). A dynamic-key-aware sweep is needed before pruning.

Not run: tsc (not installed in node_modules), build, tests. Import and export checks were done by script, not by the compiler.
