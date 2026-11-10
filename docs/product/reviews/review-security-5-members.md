# Security review 5: members, billing, workspace settings, preflight, payment hooks, entitlements, mail, jobs

Scope: src/server/routes/{members,billing,workspace-settings,account-preflight}.ts, src/server/{payments-hooks,entitlements,workspaces}.ts, src/server/mail/*, src/server/jobs/*. Read-only pass (no code changed, no tests run). Earlier reports (review-security*.md, review-privacy.md) were read; fixed items skipped.

## Authorization
Every route has withViewer + requireAuth, then requireWorkspaceRole(min) (404 for non-members and archived workspaces, 403 below the minimum) or a site permission (BILLING_MANAGE, PLANS_MANAGE, WORKSPACE_READ). The only routes without a workspace guard are by design and own-data only: POST /invites/accept (token hash lookup, generic 404, per-user miss limiter), GET /billing/mine, GET /workspaces/archived, POST /workspaces/:id/restore (owner role IN the where), GET /preferences, PATCH /preferences, GET /account/delete-preflight (session id only). Object-level: workspaceId is in every where; link/invite revoke and resend carry workspaceId plus the owner-made rule; role change and removal are conditional on the role that was read; transfer, leave and removal serialize on a workspace row lock; the last owner cannot leave. No ids, roles or owners come from the body (role validated against viewer/member/admin; `owner` is never grantable).

## Webhook / payment idempotency
recordOrder and recordMembership are upsert-style with P2002 handling; stale membership events change nothing (conditional on lastEventAt); refunded is final; applyWorkspacePlan is conditional on the plan it read and picks the highest still-granting plan; cancel loops are bounded (5) and treat 404 as done; a refund before its order throws so the platform retries. customerRef (`user:workspace`) and the metadata keys `workspaceId` / `plan` are set only by routes/billing.ts; the generic checkout strips both keys and refuses plan price keys.

## Entitlement bypass
Limits come only from getEntitlements. Seats are taken with one conditional update (`member_count < limit`) inside the transaction that consumes the link; read-only is enforced at accept, link/invite create and resend. The plan changes only from platform events or the daily sweep. Checkout takes the price key from our own plan table, never an amount. No bypass found.

## Email leaks
Member directory: masked email only for admin+ (short local parts fully masked). Invites store only an HMAC hash; the address travels only in the AES-GCM sealed job payload (bound to the inviter) and is never logged or audited. Preflight candidates and staff lists return names only. Mail templates run text through clean() and the HTML through escapeHtml(); sendMail refuses CR/LF in subject, a malformed `to`, and never logs a body, address or key; fixed endpoint, redirect manual, 8 s timeout. The invite preview (with the raw token) goes only to the inviter who just made or resent it.

## Findings
No exploitable findings; nothing was changed. Low-severity notes, left as is:
1. invite-email job (jobs/invite-email.ts): it does not re-check that the inviter (`by`) is still an admin/owner when the job runs, so an email queued just before a demotion or removal still goes out. The invite row itself stays valid by link, and admin-role invites are already dead at accept time when the maker was demoted, so the impact is a delivered email only.
2. POST invites/:id/email: a wrong address answers a 422 `mismatch`, a small oracle for an admin who is not the inviter; admin-only, hourly email caps apply to sends but not to mismatches.
3. sweepEndedMemberships matches memberships by the plan's own price key only, so after an upgrade (pro to team) the daily sweep can move the workspace to free when the team membership ends while the old, cancel-at-period-end pro one still grants access until its period ends (applyWorkspacePlan would have kept pro). Correctness, not security; self-corrects on the next event.
4. Archiving a workspace does not cancel its paid subscription (billing continues until the owner cancels). Product decision, not security.
5. Carried over from review 4: createdRecently / emailLimited are read-then-write soft caps; non-admin-role links of a removed admin keep working until an owner revokes them.

## Performance
No N+1: the member list is one page query plus one `in` user query; preflight is two parallel prepared statements plus one candidate query; sweeps and cleanups are keyset-paged and bounded; entitlements are one read per request, memoized.

## Tests
No fix was made, so no new test was added.
