# Review: board sync, moves, positions, undo

Scope: `src/server/routes/boards.ts` (`/rev`, `/changes`, card and lane move, archive/restore, `bumpRev`), `src/app/board-state.ts`, `use-board-sync.ts`, `boards/actions.ts`.

## Checked and sound
- **Rev gaps / lost updates on the server:** every write bumps `boards.rev` under a row lock and stamps `updated_rev` in the same transaction; revs commit in order. `/changes` reads the board rev first and bounds rows by `updated_rev <= rev`, so a write landing mid-request shows up in the next delta, never skipped. Stale or no-op moves throw and roll the bump back. Card move recomputes its key under the board lock, so two concurrent moves cannot share a key.
- **Client rev:** own writes never change `board.rev` (only `position`), so another user's change at N+1 is never skipped by our write at N+2; our own write comes back in the next delta and is idempotent.
- **Undo into a missing lane:** `moveCardInLanes`, `revertCardMove`, `insertCard` ignore an absent lane; the server answers 404 (`LaneGone`) for an archived target and rolls back, and the client shows the toast. Undo of a move anchors on the previous card id, falling back to the old index.
- **Duplicate application:** `applyChanges` removes a card everywhere before re-inserting; applying twice is a no-op (tested).
- **Hidden tab:** the timer keeps firing but `run()` returns before any request while hidden; visibility/focus wake it at once.

## Bugs fixed
1. **Stale delta overwrote a finished local write (sync hook).** The poll only checked `inflight === 0` before and after its `/changes` fetch. A move that started and finished during the fetch left `inflight` at 0, so a delta computed before the move put the card back and moved `board.rev` backward until the next poll (visible flicker/jump). Fix: `tracked()` bumps a `writeGen` counter at start and end; the poll drops its answer when it changed.
2. **Position keys grew without bound (server and client).** Repeated inserts into one gap add about one character per six inserts; `position` is `VarChar(64)`, so around 350 inserts in one gap would have made the move 500 (22001) forever for that gap. Fix: new `src/lib/position-key.ts` `keyOrNull` (null above 48 chars); `keyAfter` falls back to the list end (as it already did for equal keys), the client keeps the old key. Nothing was renumbered at the time of this review; see "Rebalancing" below.
3. **Reversed neighbours returned a bogus key.** This `fractional-indexing` version does not throw for `before > after` (`generateKeyBetween('a2','a1')` gives `a1V`), contradicting the doc's "null when out of order". `keyOrNull` now returns null for `before >= after`.
4. **An older delta could move the rev backward** (poll racing a reload). `applyChanges` now ignores a delta whose rev is lower than the board's (`isOlderRev`).
5. **Lost access via 403** now stops polling like 404 (the routes answer 404 today, so this is defence only).

## Not fixed, for the owner
- **Rebalancing: now implemented** (was listed here as not done). A move into an exhausted gap renumbers the lane's siblings in the same transaction with one `UPDATE ... FROM unnest`, capped at 501 cards or 51 lanes. The board `rev` is stamped once. `/changes` truncates over 300 rows, so a client that is behind does a full reload.
- **Polling after 404/403 stays off** until the board id changes or the page reloads; fine for lost access, a transient 404 would need a reload.
- Optimistic move when `keyBetween` is null keeps the old key at the new index, so a delta before the server answers could re-sort it; the poll is paused during the write so this only shows if the answer fails.
- Two quick moves of one card can reach the server out of order; the final state heals on the next delta.

## Tests
`tests/sync-review.test.ts` (new): key length bound, reversed/equal neighbours, rev comparison, stale delta ignored, idempotent delta, archived lane in a delta, window eviction, revert/undo into absent lane.
