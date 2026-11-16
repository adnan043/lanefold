# Review 10: full security check, whole site (2026-11-16)

Scope: every route in `src/server/routes`, the access helpers, jobs, flows, pages, layouts, headers/CSP, secrets in git,
and the client renderers. Five independent passes (boards and sharing; cards, files and search; chat and notifications;
members, billing and import/export; auth, pages, jobs and config), each finding then checked in the code.
`npm audit --omit=dev`: 0 vulnerabilities. `npm run platform -- check`: template files untouched, up to date (0.10.22).

No critical, high or medium issue found. Object-level checks, guest/member/admin limits, private chats, notification
ownership, email privacy, CSRF (same-origin + double-submit), CSP (hash-based, no `unsafe-inline`), open redirects,
share and invite tokens, payment hooks (idempotent; test mode never grants in production), CSV export, file uploads
and XSS sinks all held.

## Fixed (tests: `tests/integration/security-audit-2026-11.test.ts`)
- **A member a board admin removed could self-join back.** Review 9 stopped the invite link; `POST /boards/:id/join` still
  ignored `board_removals`. It now answers 403, checked inside the INSERT too. Leaving on your own, or an admin re-adding
  you, still works.
- **An archived board could be duplicated.** `POST /boards/:id/duplicate` now answers 409 `board_archived`, like other writes.

## Left open (low / informational)
- A workspace member can self-join a board (or accept a board link) while the workspace is read-only; no quota is used.
- Chat messages carry the bare ids of linked cards to every reader; titles of cards they cannot see are not sent.
- PDFs open inline (from the file host's origin, not the app's).
- HSTS has no `includeSubDomains`; `img-src` allows any https host (no user content renders remote images today).
- `activeMemberships` does not filter test mode; nothing calls it.
- Everything listed under "Left open" in review 9 still stands.
