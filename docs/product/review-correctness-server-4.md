# Correctness review, server (round 4)

Scope: src/server/** (boards, lane-actions, board-extras, board-share, public-board, card-detail, members, workspace-settings, billing, checkout, payments-hooks, entitlements, notifications, search inbox, import-export, chat-extras, jobs/*) and prisma/schema.prisma. Not repeated: what reviews/review-correctness-server-3.md and reviews/review-idempotency.md already covered. Integration tests were not run (no TEST_DATABASE_URL); unit tests `tests/card-detail-routes.test.ts` and `tests/guard-server-rules.test.ts` pass.

## Fixed
- card-detail.ts `labelWrite` (rename, recolour, delete a board label): the board `rev` was bumped but no card was stamped, and `/boards/:id/changes` lists only changed cards. Other people with the board open kept showing the old label name/colour (or a deleted label) on every card until a full reload. The cards carrying the label are now re-stamped with the new rev inside the same transaction (one bounded UPDATE, `LIMIT 400`, just past the 300-row delta cap, so a label on very many cards ends in `truncated` and the client reloads instead of doing a long write).

## Verified OK (no change)
- Lane card counters: add cards, lane move-cards, copy lane, card move, archive/restore card, archive-cards, inbox capture and triage, import chunk, card-from-message all change `lanes.card_count` under the board row lock with a conditional `card_count + n <= MAX` UPDATE; refused paths throw and roll back the rev bump.
- Keyset/rank: `keyAfter` is recomputed under the board lock for card and lane moves; exhausted keys rebalance in one statement with the rev the write will commit; stale afterId is 409; archived neighbours are excluded consistently by every finder. Export/cards cursors compare `(position, id)` with the same collation as the ORDER BY.
- Lane restore and lane copy re-count the 50-lane cap after the lock; copy falls back to the end when no key fits.
- Checklist/comment/attachment counters: item done flips are conditional (`doneAt` in the where), so a double click never double counts; checklist delete subtracts counted totals under the lock; attachment complete is idempotent (`ready=false` in the where) and reserves quota with one conditional UPDATE; delete re-reads `ready` under the lock; the trigger gives storage back.
- Members: seat is one conditional UPDATE (`member_count < max`) in the same transaction that consumes the link/invite; P2002 on a double click becomes `alreadyMember` (the transaction already rolled back, so no link use is lost); removal and leave serialise on the workspace row, the last-owner check rolls back; role change is conditional on the role read; transfer is two conditional writes in one locked transaction.
- Payments hooks: order and membership writes are idempotent (unique checkout/subscription id, P2002 fallback, `lastEventAt` guard); plan follows the highest granting membership; grace clock start is idempotent; refund waits for its order (throws to retry).
- Entitlements: memoised per request and dropped by `forgetEntitlements` after join/leave/upload; the over-limit state starts its own grace clock; cache keys (`app:settings`, `app:config`, `billing:plans`, `pubboard:<id>:`) are cleared by every route that changes what they hold. The public board cache is keyed by `rev`, and share create/rotate/revoke bump `rev` and clear the prefix.
- Public board link: leaving `public` through PATCH /boards/:id already clears `share_token_hash` (a revoked token cannot come alive again when the board is set back to public).
- Jobs: sweeps and cleanups are keyset-paged, bounded and conditional; invite-email and notification-email claim before send and give the claim back only on retryable results; `file-cleanup` treats unreachable/5xx as uncounted; the retention values are clamped.
- Notifications list keyset: `lastSeen` is the last row looked at, `hasMore` covers both the page cut and the scan cut.
- 404/409 mapping: archived board/lane/workspace and read-only workspace answer 409, unseen ids answer 404, in every route read.

## Minor, not changed
- boards.ts `PATCH /cards/:id` with `completed: true` on an already completed card overwrites `completedAt` (the details route keeps the first time). Needs a read before the write; the UI uses the details route.
- Removing a member deletes their `card_members` rows without stamping those cards, so other open boards show the old assignee face until the next change to the card.
- Restoring an archived workspace is not re-checked against the 10-own-workspaces cap (archive, create more, restore).
- `workspaces.member_limit` is a denormalised copy that nothing enforces (limits come from `plan_limits` through entitlements); it is written on plan changes only.
- Inbox cap counts completed cards, which the Inbox list hides.
- A board with a stale `share_token_hash` and `visibility = workspace` from before the clearing fix would revive its old link if set to public again; new data cannot reach this state.
