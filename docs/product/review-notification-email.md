# Review: notification emails (Phase 12)

Scope: job, route, settings screen, migration, schema, wiring, tests. Static review only (build, tests, prisma not run).

## Security
- Authorization: route is own-row only (`userId` is the viewer's; no id from the client). Guards in order (validator, withViewer, requireAuth, withDb). The global `sameOrigin` + `csrf` cover PATCH. OK.
- Address: read only in the job, in memory, from `users`, active + verified only; never stored, in a payload, logged (only user id and result kind), cached or returned. OK.
- Email content: counts only; no names, titles, or addresses. Subject has no input and is control-char cleaned; `sendMail` also refuses CR/LF/NUL in subject and whitespace or separators in the address. No header injection path.
- Mode CHECK exists in the migration (plus validator on the route). Migration is idempotent, in BEGIN/COMMIT, index name matches Prisma's.
- Idempotency: the cursor is claimed with compare-and-set before sending (mode + old cursor), concurrency 1, provider Idempotency-Key `notif-<user>-<max>`. A repeated or concurrent run gets count 0. A retryable failure gives the claim back (only if the cursor is still ours).

## Fixed
1. Rate-gap bypass: switching off then on reset `email_notified_at` to null, so a person could trigger an email every toggle, ignoring the hourly/daily gap. The route no longer resets it. (src/server/routes/notification-email.ts)
2. Form rules: a failed save only showed a toast. It now shows an inline danger Notice (`role="alert"`) next to the field; the "Saving..." text is `role="status"`. (src/app/settings/notifications.tsx)
3. Added tests/integration/notification-email-route.test.ts: 401 when anonymous, default off, no address in the response, only the viewer's row changes (a body naming another user is ignored), cursor starts at the newest notification, the gap is not reset by off/on, bad input gives 422 and writes nothing, DB CHECK refuses an unknown mode.

## Performance
- One candidate query (index `(email_notify_mode, user_id)`, then `EXISTS` on `notifications(user_id, read_at, id)`), LIMIT 50, 40 s budget; then two batched reads for all candidates, no N+1. Per candidate: one claim update plus one send (bounded 50 per run, 8 s mail timeout each). OK.
- The route: at most 3 small queries on PATCH, 1 on GET.

## Left (minor, not changed)
- Notification ids are sequence-ordered; a transaction that commits out of order (id 10 after 11 was seen) could be skipped by the cursor. Rare, only costs one missed email.
- A final failed send (4xx, or retries used up) keeps the claim: those mentions are skipped, by design (no endless retries).
- Rolling a claim back sets `email_notified_at` to null rather than the previous value; bounded by the retry count.
- No per-user rate limit on PATCH; it only touches the person's own row.
