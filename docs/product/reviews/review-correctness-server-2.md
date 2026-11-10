# Server correctness review, round 2 (top 10)

Read-only. CONFIRMED = traced in code and schema; SUSPECTED = plausible, not reproduced. Round 1 findings are not repeated.

Checked and fine: the move CTE's same-lane, cross-lane, full-target, archived-card and activity-only-when-moved branches; `row.moved` (`count(*)::int` arrives as a JS number); the `Prisma.join(..., ' UNION ALL ')` separator; NULL handling in the `cardsAfter` row comparison; lanes with 0 cards; the 50 lanes x 16 cap loop; `ensureGeneralChannel(tx)` inside the workspace transaction; `viaCard` refusals (a non-member gets 404 from `cardCtx` before any 403/409, so nothing leaks); both new indexes versus their queries.

## 1. A late "ended" event from an old subscription downgrades a workspace that has a newer active one (MEDIUM, CONFIRMED)
`src/server/payments-hooks.ts` `applyWorkspacePlan` (about line 118) and the cancel route `checkout.ts:260-262`.
- Scenario: workspace W has sub A (pro). The owner cancels, then subscribes again (sub B, same price key). B's `active` event is applied, then A's `ended` event arrives. `recordMembership` is not stale, because it is a different `subscriptionId` with its own `lastEventAt`.
- `applyWorkspacePlan` sees `!grantsAccess` and `workspace.plan === bought.plan`, so it sets the plan to free.
- The daily sweep correctly sees B as active, but it only moves workspaces down, so W stays free until B's next event.
- Fix: when the event does not grant access, skip the downgrade if another membership exists for `workspace_id` + `price_key` with `status IN ('active','trialing','past_due') OR access_ends_at > now()` (the same predicate as the sweep).

## 2. A stale card move commits a board `rev` bump and `updated_at` (LOW, CONFIRMED)
`src/server/routes/boards.ts:1027`. The `'stale'` branch returns instead of throwing, so the transaction commits the `boards.rev + 1`. Only the full-lane branch throws and rolls back.
- Scenario: two users drag the same card. The loser gets 409 `stale`, but the rev has still advanced with no row changed. Every other client sees a rev gap and may refetch.
- Fix: throw a `Stale` error (the same pattern as `LaneFull`) and map it to `stale(c)`.

## 3. The move's target-lane update does not check `archived_at IS NULL` (LOW, SUSPECTED)
`src/server/routes/boards.ts` about 1004-1010. The lane is validated before the transaction.
- Scenario: the lane is archived between the validation and the CTE. The card moves into an archived lane and its counter goes up.
- Related: if the lane row is missing, `t` is empty, `room` is false, and the client gets a misleading `lane_card_limit`.
- Fix: add `AND lanes.archived_at IS NULL` to `t`. Detect this case separately and answer 404 or stale.

## 4. A crafted lane-cards cursor id above int4 gives a 500 (LOW, CONFIRMED)
`src/server/routes/boards.ts` `cursorOfCard` (`\d{1,10}`) feeding `cardsAfter` (line 126, `${cursor.id}::int`). `GET /lanes/:id/cards?after=A|9999999999` raises Postgres 22003, "integer out of range".
- Fix: check `Number(m[2]) <= 2_147_483_647` (and a positive value) in the route and return 422.

## 5. The 10-card cap on a chat message can be exceeded by a race (LOW, CONFIRMED)
`src/server/routes/chat-extras.ts` about 160 (`msg._count.cardRefs` read) versus the transaction at about 188. The count is read outside the transaction, and the transaction locks only the board. N parallel requests targeting different boards, or the same board before the lock, all see the same count and each insert a ref.
- Fix: inside the transaction, run `SELECT 1 FROM messages WHERE id = ${msg.id} FOR UPDATE`, then recount `message_card_refs` before the lane update. Do not take this lock before the board lock, to avoid a lock-order inversion.

## 6. The derived description can lose its footer, and title limits count UTF-16 units (LOW, CONFIRMED)
`chat-extras.ts` about 177: `descriptionFromMessage(...).slice(0, 20000)`. A message near 20,000 characters loses the "From chat: #channel" back-reference. The slice can also split a surrogate pair, which Postgres stores as U+FFFD.
- A user-given title uses `textField(..., 200)`, which counts `.length` in UTF-16 units, so 101 emoji are rejected while `titleFromMessage` counts code points.
- Fix: truncate the body (`Array.from(body).slice(0, 20000 - footer.length)`) and then append the footer. Align the title counting with code points.

## 7. Board open orders and caps by `lane_id`, not by lane position (LOW-MEDIUM, CONFIRMED)
`src/server/routes/boards.ts:667` (`ORDER BY lane_id, ...` plus `LIMIT BOARD_CARD_CAP + 50`) and the cap loop at about 676.
- Scenario: a board with many full lanes where an old lane was dragged to the front, so its id is high. The cap and the outer LIMIT cut by id, so the left-most lanes can come back with `loaded: false` and no cards while later-positioned lanes are filled. The client lazy-loads them correctly, but the first paint is wrong and it costs extra requests.
- Fix: put the lane's index in `lanes` order into each branch (`${i}::int AS ord`) and `ORDER BY ord, position COLLATE "C", id`.
- A lane cut mid-way by the cap shows `loaded: true` with a partial list. This is correct only if the client continues from the last card's cursor.

## 8. `cleanupOld` can starve behind permanently failing uploads (LOW, SUSPECTED)
`src/server/jobs/sweeps.ts` about 133-150. Every run restarts at id 0 with 4 x 25 rows. A row whose `deleteFile` returns a non-ok, non-404 status (401, 403, 5xx) is left in place, forever. 100 such rows at the front block all later abandoned uploads.
- Fix: also stamp or skip failing rows, for example by moving them to a retry-after column or by rotating the starting cursor per run. At minimum, log a count of failures.

## 9. The cancel route stamps `now()` from the server clock against platform event times (LOW, SUSPECTED)
`payments-hooks.ts` `recordMembership` (`eventAt` defaults to `new Date()`) and `checkout.ts:260`. If the platform's clock is behind ours, or its events carry the time they were created rather than when they apply, a legitimate later platform event (for example an un-cancel or a renewal with the same subscription id) gets `createdAt < lastEventAt` and is silently dropped as stale.
- Fix: use the platform's own timestamp from the cancel response if it has one. Otherwise subtract a small slack (a few seconds) from the stamp.

## 10. Duplicating the user's Inbox board, and the archived-lanes count subquery (LOW, SUSPECTED)
- `src/server/routes/board-extras.ts` `POST /boards/:id/duplicate`: the source is not checked for `inbox_of`. If `boardAccess` allows the owner onto their personal Inbox, a normal visible copy of it is created. Fix: refuse when `inbox_of != null`.
- `board-extras.ts` about 120, the archived-lanes count subquery: it filters `k.lane_id` and `workspace_id` but not `board_id`, so it cannot use the new partial index `(board_id, lane_id, position, id)` and falls back to another index. At 50 lanes per page this is cheap, but add `AND k.board_id = ${boardId}` to match the partial index.
- Also in `cardsAfter` (`boards.ts:123`): no `board_id`, so it uses the full `(workspace_id, lane_id, position, id)` index. That is fine and intended.
