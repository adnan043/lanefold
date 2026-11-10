# Performance review 4

Date 2026-11-03. Scope: `src/server/routes/*.ts`, `src/server/jobs/*` against `prisma/schema.prisma` and migrations. Unit tests only; no build, no integration tests, no migration run.

Method: re-checked every open item of `review-performance-3.md` against the code, then scanned all loops, `count()`, `skip`, `findMany` and `$transaction` sites in routes and jobs. N+1: none found. Offset paging: none. Every `findMany` is bounded by `take`. The schema has an index for each query shape found (messages, cards, notifications, comments, activity, memberships).

## Fixed now
1. Chat send (`routes/chat.ts`, POST `/conversations/:id/messages`): the replay lookup, both rate-limit reads, the reply-parent check, `mentionable`, `cardsInWorkspace` and the mention names now run in ONE `Promise.all`. `mentionedInBody`'s extra user read is gone on this path (`mentionIdsIn` with the preloaded names; `mentionedInBody` is still used by edit). The order of outcomes is unchanged (replay, 429, 404 parent). Round trips before the transaction: about 7 sequential down to 1.
2. `/chat/pulse` (`routes/chat.ts`): the two reads now run in parallel (a relation filter is not possible: `Conversation` has no `workspace` relation), so a poll costs one round trip of latency instead of two; the workspace read is bounded (`take: 200`).
3. `softLimited` (`soft-limit.ts`, used by search): one cache read and one write instead of two reads and a write per keystroke. `softCount` / `softHit` stay for `members.ts`.
4. Export rate-limit read (`import-export.ts`): new index `audit_events(actor_user_id, action, id DESC)`, in `schema.prisma` and hand-written migration `prisma/migrations/20261103170000_audit_actor_action_idx/migration.sql` (BEGIN/COMMIT, `IF NOT EXISTS`). NOT applied; needs `prisma migrate deploy` (Migrate step of publishing).

## Left open (not fixed, real but bounded)
- Notifications list and unread count (`routes/notifications.ts`): `LIMIT` applies after the per-row `EXISTS` visibility filter, so rows a user lost access to are scanned each time. Needs a product decision: delete or mark read a user's notifications for a board or chat when their access is removed (board member removal, conversation leave, workspace removal), plus a `LIMIT 500` inner scan as a backstop (which can undercount slightly). Not done here, since it touches the semantics of the count and several write routes in files others edit.
- Export (`import-export.ts:207-300`): up to about 350 sequential queries per request (one read per lane plus 6 per 100-card batch, cap 5000 cards). Bounded and streamed. Proper fix is one keyset read over the board joined to lanes, or a background job that writes a file.
- `sweepPlans` (`jobs/sweeps.ts`): about 4 writes per row inside a paged daily job. Fine at current volumes.
- Minor: `chat.ts` send still calls `shapeMessages` for the sender's own new message (a fresh message has no reactions; could be built from `created`); `board-extras.ts` archived-lanes counts cards per row (max 51 index lookups; `lanes.card_count` could replace it); `boards.ts` `/boards/:id/changes` re-reads the board row.
- Cache: only `entitlements.ts` uses `cache.getOrSet` (correct). Plan ladder reads in `billing.ts` (`planLimit.findMany`, take 10, tiny table) could go through `cache.getOrSet` with a 1 h TTL cleared on plan save; skipped as low value.
- Jobs: `files.ts` (parallel batches, `MAX_BATCHES`), `invite-email.ts` (one paged read, per-item send), `sweeps.ts` deletes in bounded batches. No unbounded loops.

Verified: `npx vitest run tests/chat-server-mentions.test.ts tests/soft-limit-prefs.test.ts tests/chat-routes.test.ts` pass (23 tests).
