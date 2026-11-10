# Rules compliance sweep (AGENTS.md hard rules)

Scope: `src/`, `public/`, `prisma/`, `scripts/` (excluding `src/generated`, `node_modules`). Scripted greps plus small Python multi-line scans (scripts in the session scratchpad: `sweep.sh`, `s2.sh`). Read-only. `src/platform/` is managed, so its hits are noted but not counted as violations.

## Summary

| Class | Count | Verdict |
| --- | --- | --- |
| Hex colours outside tokens | 5 sites (board colour presets, kit demo) | Exception for presets (user-pickable data); fix the kit demo |
| `style=` / `style={}` | 2 real (dnd-kit) | Exception (known) |
| Inline event handlers | 0 | OK |
| `dangerouslySetInnerHTML` / `set:html` / `innerHTML` | 3 | Exception (JSON-LD, static button label) |
| `window.confirm/alert/prompt` | 0 real | OK (hits are `useConfirm`) |
| `target="_blank"` without `rel` | 0 | OK |
| `$queryRawUnsafe` / `$executeRawUnsafe` / `Prisma.raw` | 0 | OK |
| String-built SQL | 0 outside `src/platform` | OK |
| `data: body` / spreads | 0 raw body spreads | OK (spreads are of validated, field-picked objects; see note) |
| `process.env` outside config | 3 (`scripts/seed-demo.ts`) | Exception (local-only script, refuses non-localhost) |
| `import.meta.env.DEV` | 5 | Exception (dev flag, not config/secret) |
| `console.log` of secrets | 0 | OK (script logs mask the email) |
| `Cache-Control: public` with viewer | 0 | OK |
| `setTimeout`/`setInterval` on server | 0 | OK (1 browser hit) |
| Offset paging | 0 | OK |
| `count()` in request paths | 11 | Mostly OK, 1 note |
| Queries in loops (N+1) | 0 confirmed (16 heuristic hits) | Needs 3 spot checks |
| Plain `fetch(` in browser | 0 | OK |
| `<a href>` to app/portal paths | 0 | OK |
| Password inputs without reveal | 0 (4 inputs, all have reveal) | OK |
| Forms missing `noValidate` | 1 real | Violation |
| Buttons missing `type=` | 0 | OK |
| Icon-only buttons without aria-label | 0 found | OK |
| Placeholder as only label | 0 confirmed | OK (spot checked) |
| Dependencies beyond approved list | 6 flagged | See below |
| Second lockfile / wrangler config | 0 | OK |
| `_headers` vs `headers.ts` | consistent | OK (note) |

Violations needing a fix: 1 form without `noValidate`, 1 kit-demo hex block, dependency approval gap (`uqr`, `@stripe/stripe-js`, `@prisma/adapter-ppg` are from the template, not this project).

## Details

### Hex colours (5 sites)
- `src/app/boards/board-settings.tsx:13-19` (preset board backgrounds): colours are user data validated as `#rrggbb` server side, applied via CSSOM (`backgroundStyle`), not tokens. Exception. Server messages `src/server/routes/boards.ts:229,276`, `card-detail.ts:195` only mention `#5B5BD6` in text.
- `src/app/settings/accents.css:263-273` (`#ffffff`, 8 swatch colours): accent preview swatches, must show the real accent. Exception (definition of the swatch tokens); minimal fix: move to `--swatch-*` tokens in `global.css`.
- `src/portal/screens/components.tsx:441,496` (`#3b82f6`, `#1e293b`): template UI kit demo screen. Violation, minor. Fix: use token-based values, or leave (demo-only, dev route).

### style attributes (2)
- `src/app/boards/card.tsx:144`, `src/app/boards/lane.tsx:92`: dnd-kit `transform`/`transition` inline style. Known exception. The other 6 hits are comments.

### HTML injection (3 real)
- `src/layouts/Base.astro:131`: `set:html` of `jsonLdText(data)` for `application/ld+json`. Exception (serialised JSON, not user HTML); confirm `jsonLdText` escapes `<`.
- `src/lib/form.ts:51,144`: `button.innerHTML` read/restored (saved label). Exception; fix optional: store `textContent` instead.
- `src/lib/markdown.tsx`, `src/platform/sanitize.ts`: comments only.

### Dialogs
All 23 hits are `useConfirm`'s `confirm({...})` or Stripe `confirm`; no `window.confirm/alert/prompt`.

### Env reads
- `scripts/seed-demo.ts:79,109,111`: `process.env` (`DEMO_USER_EMAIL`, `DATABASE_URL`); not deployed, refuses non-local DB. Exception.
- `import.meta.env.DEV` at `src/middleware.ts:34`, `src/lib/seo.ts:13`, `src/lib/posts.ts:9`, `src/portal/routes.tsx:149,457`: build/dev flag. Exception.

### Cache-Control
All app routes use `private, no-store`. `src/server/routes/jobs.ts:169` is `public, max-age=3600` on `/sitemap`, which has no `withViewer` (the viewer routes are `/manage*`). Exception (template, correct).

### Timers
`src/pages/thanks/index.astro:100` `setTimeout` is browser-side UI. Not a server violation.

### count() in request paths (11)
`src/server/routes/card-detail.ts:576,604,645,666,745,834,863,864`, `boards.ts:511,783`, `members.ts:274`. All are scoped (workspace/card in `where`), bounded, mostly inside transactions enforcing `LIMITS` (cap checks), not list totals. Verdict: exception for limit enforcement. Note: `card-detail.ts:863-864` and `745` (comment rate limit) run per request with indexes needed on `(card_id)`, `(uploaded_by, created_at)`, `(author_id, created_at)`; verify in `review-performance.md`. Minimal fix if slow: use `take: LIMIT+1` + `length`.

### N+1 (heuristic: loop within 7 lines of an `await db/tx`)
16 hits, none confirmed as per-row queries in request paths:
- `scripts/seed-demo.ts:139,149,154,162,190`: seed script, sequential inserts. Exception.
- `src/server/jobs/sweeps.ts:20,34,53,89,102,115,131`: background sweeps iterating batches. Likely OK (bounded batches); spot check `:17-20` (nested loops).
- `src/server/routes/jobs.ts:224,229`: slug-retry loop on create (template). Exception.
- `src/server/routes/search.ts:374`: spot check needed.
Fix if confirmed: batch with `createMany` / `where: {id: {in}}`.

### noValidate
- `src/portal/ui/overlay.tsx:95`: comment text only, not a form.
- `src/pages/jobs/index.astro:47`: GET search `<form>` with `type="search"`, no required rules. Violation by letter (rule is "every form"). Fix: add `novalidate`.
(The 17 single-line grep hits in `src/app` and `portal/screens/account.tsx` all carry `noValidate` on later lines; confirmed by multi-line scan.)

### Buttons, icon buttons, labels
- Multi-line scan of every `<button>`: all have `type=`. The kit `Button` defaults `type="button"`.
- Icon-only scan found none without `aria-label`; spot-checked `Swatch`, composer send button.
- Placeholders: 30 hits; spot checked card-panel, composer, new-conversation: each has `aria-label` or a `Field` label. Not exhaustive. Items to double check: `src/app/chat/new-conversation.tsx:113`, `src/app/onboarding.tsx:130`, `src/app/members/invite-modal.tsx:155`, `src/app/inbox/inbox.tsx:158` (rely on `Field` wrapper for the label).
- `src/app/shell.tsx:166` uses a plain `<a href="/">` to the website home (not an app path), so the reload is intended. OK.

### Passwords
`login`, `register`, `reset` (x2) pages all pair `.pw-reveal` + `data-reveal-password`. No password input in `src/app`/`src/portal` besides the kit's `PasswordInput`.

### Dependencies (package.json vs SPEC.md section 3)
Approved and present: `@dnd-kit/core|sortable|utilities`, `fractional-indexing`. Approved but not installed: `@tanstack/react-virtual`, `marked` (markdown is custom in `src/lib/markdown.tsx`, which is fine). Not on the approved list but present: `uqr`, `@stripe/stripe-js`, `@prisma/adapter-ppg`, `xss` (SPEC names `xss` as existing). `git diff package.json` shows this project added only the 4 approved packages plus the `seed:demo` script; the others come from the template baseline (payments, 2FA QR). Verdict: no new unapproved dependency added by this work.

### Lockfile, wrangler
Only `package-lock.json`; no `wrangler*` file.

### Headers
`public/_headers` has nosniff, Referrer-Policy, Permissions-Policy, COOP, X-Frame-Options DENY, HSTS; `src/platform/headers.ts` sets the same values (X-Frame-Options skipped in Preview only, HSTS conditional). Consistent. The CSP is added by Astro `security.csp`.

### data spreads note
`card-detail.ts:154`, `boards.ts:817,936`, `jobs.ts:224-238`, `payments-hooks.ts:57` spread objects built from validated fields (`data`/`input`/`fields`), not raw request bodies. `jobs.ts:238` passes `c.req.valid('json')` directly (validator output, template code). Confirm those validators whitelist fields (`review-security.md`).

## Minimal fixes list
1. `src/pages/jobs/index.astro:47`: add `novalidate` to the search form.
2. `src/portal/screens/components.tsx:441,496`: replace hex in the demo (optional, dev kit).
3. `src/app/settings/accents.css:263-273`: move swatch hex into tokens (optional).
4. Spot check `src/server/routes/search.ts:374` and `src/server/jobs/sweeps.ts:17-20` for per-row queries.

## 2026-11-03: forms and buttons audit (src/app/**, src/portal/screens/**)

Checked against AGENTS.md "Buttons and forms" and "A dashboard looks like a dashboard", ui.md. Static scan (multi-line regex) plus reading the forms that do not use `useForm`.

Fixed (small edits):
- `src/app/chat/create-card-dialog.tsx`: the too-long title error was in the form's status line. It now sits under the title field (`Field error`, `aria-invalid`, `aria-describedby`), focuses the field, clears when typing.
- `src/app/cards/comments.tsx`, `src/app/cards/checklists.tsx`, `src/app/cards/card-panel.tsx` (description editor): the textarea/input had `aria-invalid` but the error `<p>` had no id and no `aria-describedby`. Added both (`useId` where several instances can be open).

Verified OK:
- All 31 `<form>` elements carry `noValidate`; no `window.confirm/alert/prompt`; no `style=""`/`style={}` in screens except the dnd-kit transforms; no hex in screens except board colour presets (user data, known exception); no raw password inputs (portal uses `PasswordInput`).
- Submit buttons with async work use `pending` + `pendingLabel`; per-row actions use `busy`/`busyId`; destructive actions use `danger` + `useConfirm` or a typed-confirm dialog (transfer, archive).
- Filter-bar inputs, hidden file input and swatch buttons are labelled (wrapping `label` with visually-hidden text, `aria-label`); the 4 scan hits were false positives.

Left (minor, not changed):
- `src/app/boards/move-card.tsx`, `src/app/cards/move-popover.tsx`: submit buttons without `pending`: the move is synchronous and optimistic, so there is no wait to show.
- `src/app/settings/workspace.tsx:340,348`: the danger buttons open a dialog (the confirmation is the dialog), by design.
- Server 422 field mapping was checked only where forms use `useForm` (it maps `fields` automatically); the composers, comment, checklist and chat composer forms show server errors as one message under the input, which is acceptable for single-field forms.
- Client rules mirroring server limits were spot-checked (titles, names, comment length), not diffed rule by rule.
- No build, tsc or tests were run for these edits.
