# Server correctness review (src/server/**), top 10

Read-only review. Each item is marked CONFIRMED (traced through code, schema and migrations) or SUSPECTED. Items 1 to 3 are the ones worth fixing first.

## 1. Plan-sweep matches subscriptions to workspaces by owner/admin, not by workspace (HIGH, CONFIRMED)
`src/server/jobs/sweeps.ts:17-27`. `memberships` has no workspace column (schema.prisma `Membership`). The sweep joins `memberships` to `workspace_members` on `user_id` with role owner/admin, for every workspace on that plan.
- Scenario A: Alice owns W1 and W2, both on `pro`. She pays for W1 only (`customerRef` `alice:W1`) and the sub ends. W2 was never paid, for example set by staff. Under the sweep W1 still has an ended membership but W2 also "has" Alice's membership. Both fall, or neither does, depending on the other memberships Alice holds.
- Scenario B (wrong outcome, kept paid): Alice has an ended `pro` sub for W1 and an active `pro` sub for W2. For W1, the NOT EXISTS sees W2's active membership via Alice (she is owner of W1 too), so W1 never falls back to free. She keeps paid features indefinitely.
- Scenario C: an admin of W1 who personally pays `pro` for their own W3 keeps W1 on `pro` forever.
- Fix: carry the workspace in the membership row. Add a nullable `workspace_id` to `memberships`, set from `refParts(customerRef)[1]` in `recordMembership`, and match `m.workspace_id = w.id` in the sweep. Short of a migration, parse `customerRef` in the sweep. Keep the user-based match only for rows with a null `workspace_id`.

## 2. Membership events are applied with no ordering guard (MED-HIGH, SUSPECTED)
`src/server/payments-hooks.ts:71-100` (`recordMembership`) and `:105-125` (`applyWorkspacePlan`). The hooks are retried (1 min, 2 min, 10 min, 1 h) and the confirm route also replays them. `recordMembership` overwrites status/period unconditionally, with no event timestamp or version.
- Scenario: `active` event fails once, `canceled` arrives and is applied, then the retried older `active` lands. The row goes back to `active`, the plan goes back to `pro`, and the sweep never downgrades it.
- Fix: store the platform's event or `updatedAt` time on the row and ignore an older event. Or re-read the subscription from the platform inside the hook.

## 3. Immediate cancel never downgrades the workspace (MED, CONFIRMED)
`src/server/routes/checkout.ts:260`. `POST /memberships/:id/cancel` calls `recordMembership(done.data)` but never calls `applyWorkspacePlan`. With `atPeriodEnd:false`, `accessEndsAt` is now, but the plan stays `pro` until a platform event arrives. In the Preview, or if the event is lost, that is until the daily sweep, which has the matching bug from item 1.
- Fix: also call `applyWorkspacePlan(done.data)` after the record.

## 4. Archived lane: its cards stay live everywhere else (MED, CONFIRMED)
`src/server/routes/boards.ts:842-852` only sets `lanes.archived_at`. The cards keep `archived_at NULL`, and `card_count` is unchanged.
- `src/server/routes/search.ts:175` (search) and `:238` (My Day) join `lanes l` with no `l.archived_at IS NULL`. The cards of an archived lane show in My Day and in search results, but the board and lane views cannot display them. Opening one gives a card with no visible home.
- The search and My Day queries do not exclude them. Chat card refs, `/cards/:id` and the deep-link route behave the same way.
- Fix: add `AND l.archived_at IS NULL` to both queries. Alternatively archive the lane's cards and zero `card_count` in the same transaction.

## 5. Keys for card/lane create and move are computed outside the transaction (LOW-MED, CONFIRMED)
`src/server/routes/boards.ts:890` (add cards), `:955` (move), `:831`. `cardFinder(...)` reads the last or neighbour position before `bumpRev` takes the board row lock.
- Two parallel adds in one lane get identical keys (positions are not unique). Order falls back to `id`, so it is stable.
- Reordering after one of two equal-key cards throws inside `generateKeyBetween` (a >= b). `keyAfter` catches this and appends to the end (`:445-448`), so the user's drop target is silently ignored. The inbox and triage paths (`search.ts:332`, `:362`) share the same read-before-lock window.
- Not a crash, but wrong placement. Fix: do the read of last or neighbour after `bumpRev`, inside the tx.

## 6. Attachment delete reads `ready` before the lock (LOW-MED, CONFIRMED)
`src/server/routes/card-detail.ts:975` (and `:960-972`). `row.ready` comes from `attachmentRow` before the transaction. If `/attachments/:id/complete` flips `ready=true` in between, the delete sees `ready=false`. It skips both the `storage_used_bytes` decrement and the `attachmentCount` decrement, while the row is deleted.
- Effect: permanent counter drift, so the workspace has less storage quota than it should.
- Fix: re-read `ready` and `size` inside the tx after `bumpRev`, using the deleted row via `DELETE ... RETURNING`.

## 7. Unfinished uploads are never cleaned up (LOW, CONFIRMED)
`src/server/routes/card-detail.ts:~890-905`. `ready=false` rows are created at step 1 and nothing deletes the abandoned ones. The cleanup job (`src/server/jobs/sweeps.ts` `cleanupOld`) covers only invites, join links and notifications.
- Effect: each abandoned row counts toward `unfinishedUploads` for 1 h only. The platform's stored file and the row stay forever.
- Fix: add a daily cleanup of `attachments WHERE ready = false AND created_at < now() - interval '1 day'`, calling `deleteFile` for each.

## 8. `old-data-cleanup` rejects a manual run with no data (LOW, CONFIRMED)
`src/server/jobs/index.ts:20`. `data !== null && typeof data !== 'object'` throws `DontRetry` when `data` is `undefined`. The schedule in `background.json` passes an object, so the scheduled run works. A manual or `sendJob` run without data fails permanently without being retried.
- Fix: treat `undefined` like `null`.

## 9. DM replay returns an unread of 0 (LOW, CONFIRMED)
`src/server/routes/chat.ts:~628`. `POST /workspaces/:id/conversations` for an existing DM builds the shape with `{lastReadSeq: 0n}`, and the unread count is then computed against a fake read marker of 0. The API reports the full history as unread for an existing DM. This is cosmetic, because the client re-reads `/chat/pulse`.
- Fix: load the real `conversationMember` row for `existing`.

## 10. Workspace creation is not idempotent against #general (LOW, SUSPECTED)
`src/server/general-channel.ts:9-12`. There is no unique constraint on `(workspace_id, name)` for channels. `ensureGeneralChannel` runs outside the workspace-creation transaction (`routes/boards.ts:519`). A crash or retry between the two leaves a workspace with no `#general`. Two concurrent calls make two. Moving it into the create tx (it accepts a Tx) fixes this.

## Checked and fine
- Prisma field and relation names, composite unique selectors (`conversationId_clientId`, `workspaceId_dmKey`, `userId_boardId`, `conversationId_userId`) and required create fields match `schema.prisma` and the migrations.
- Raw SQL matches the migration tables and columns: `workspaces.member_count`, `plan_limits.price_key_monthly`, `app_settings`, `cards`, `lanes` and the rest.
- BigInt: `rev`, `seq`, `last_seq` and notification ids are stringified or `Number()`ed before `c.json`. No raw BigInt reaches JSON.
- `position COLLATE "C"` is applied to all four position columns. The raw SQL ordering uses `ORDER BY position, id` on those columns and is consistent.
- `card_count`, `member_count` and `last_seq` updates are atomic conditional or increment statements under a lock. Chat `client_id` and `(conversation_id, seq)` unique indexes give correct idempotency, and `P2002` handling is in place.
- The board open query's `rn` and keyset cursors use `position|id` tiebreaks and do not skip or repeat rows. The cleanup cursors are monotonic. NOT IN is not used anywhere with nullable operands.
- My Day takes the client's local date within plus or minus 2 days, and DATE columns are read as UTC midnight. Due-date to day conversion is consistent. Grace periods use `now()` in SQL.
