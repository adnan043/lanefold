# Review 8: authorization-first pass over src/server and src/pages (security)

Scope: files changed since review 7 (11:45): `routes/billing.ts`, `pricing.ts`, `pages/pricing.astro`, plus the diffs of `app.ts`, `payments-hooks.ts`, `routes/checkout.ts`, `background.ts`, `permissions.ts`, `auth-settings.ts` and the pages touched at 12:25 (no content change there beyond the earlier diff). Skipped as other agents are mid-edit: custom fields (`card-fields.ts`, `field-shapes.ts`, the `card-detail.ts` edits), dependencies, recurring cards, templates, flows, saved filters, share expiry.

## Fixed
Nothing needed fixing. No code changed.

## Verified OK
- billing.ts authorization: workspace routes use `requireWorkspaceRole` (checkout = admin, read = viewer; non-members get 404); `/billing/mine` filters by the viewer's own membership rows in the `where`; site routes carry `requireAuth` + `requirePermission` (`BILLING_MANAGE`, `PLANS_MANAGE`, `WORKSPACE_READ`); the staff workspace list is keyset paged, audited, names only (no emails).
- Plan checkout: the price is chosen from our own `plan_limits` by plan name, never an amount from the browser; downgrade/same plan refused; `customerRef` (`<userId>:<workspaceId>`) and `metadata.workspaceId/plan` are set only here. The generic `/checkout` strips `workspaceId`/`plan` from metadata, sets `customerRef` to the user id only, and refuses any plan price key (404), so a browser cannot buy a plan for a workspace of its choice. Rate limited per user (10 and 20 per 10 min).
- Input: `PATCH /billing/plans/:plan` validates every number against `SAFETY_CAPS`, enforces the storage ladder, uses `updateMany` (never creates), audits, clears both caches. Plan, gateway and price-key formats are regex-checked.
- Data exposure: price keys never reach the browser except to `PLANS_MANAGE`; public pricing carries no visitor data (`Cache-Control: public` is correct there, the route reads no viewer). Checkout answers drop email, metadata and customer ref.
- Payment hooks: refParts accepts digits only; membership writes are conditional on event time; plan = highest granting membership; refund only cancels when exactly one candidate matches; the confirm route trusts only the platform's own checkout answer. Raw SQL is tagged with bound values.
- Cancel route: a buyer who left or was demoted gets 404 for a workspace plan; only admins/owners (or the owner of an archived workspace) can cancel.
- `pricing.astro`: no `set:html`, plain `<a>` links, viewer only for the CTA; no public Cache-Control on pages that read the viewer (only `sitemap.xml` is public, and `/b/<token>` is `private, no-cache`).
- Greps clean: no `Unsafe` raw queries or `Prisma.raw` in `src/` (outside generated code); every by-id read/write found carries workspace/board/user in the `where` or runs after a scoped lookup; routes without `requireAuth` are the intended public ones (`/site`, public board, public plans, checkout start/gateways/confirm).
- `auth-settings.ts`: relaxed email verification only when `import.meta.env.DEV`, preview, a localhost URL and no Site Key all hold (false in every build). `devFileRoutes` refuses everything unless dev with no Site Key.
- CSP: no inline handlers, `style=""` or `set:html` in the changed pages.

## Minor, not changed
- `GET /site-api/checkout/gateways` and `GET /site-api/billing/public-plans` are public with no per-IP limit; the platform call is cached 60 s (`listPrices`) / the plans 1 day, so cost is bounded. `gateways` calls the platform each time.
- `GET /site-api/checkout/:id` is anonymous by design (the unguessable `pcs_` id is the capability) and replays the hooks idempotently.
- Carried over from review 7 (unchanged): Inbox board PATCH guard, workspace cap on restore, DM rejoin.

## Tests
No code changed, so no new tests. Not run: integration suite (no database allowed).
