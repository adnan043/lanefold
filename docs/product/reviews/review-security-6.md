# Review 6: position rebalancing, pulse, invite email (security + performance)

## Authorization / security
- boards.ts rebalance: PASS. Ids come from a read scoped by workspaceId + lane (cards) or board (lanes) inside the transaction, after the board row lock; nothing from the client reaches the UPDATE. `laneId` is checked against board + workspace before the transaction. Raw SQL is tagged only; `${idList}::int[]` and `${keys}::text[]` are typed. Fixed: the cards UPDATE also filters `board_id` (defence in depth; was workspace + lane only).
- Cap: take is 501 cards / 51 lanes (siblings exclude the mover, so a full lane of 500 / board of 50 fits). If a lane ever held more (imports bypassing the cap), the surplus rows would keep old keys and could sort wrongly: not reachable today, noted.
- Rollback: StaleMove / LaneFull / LaneGone throw inside the transaction, so rebalance + rev bump roll back together. 'exhausted' cannot come back in non-signal mode.
- Lock order: every writer takes the board row first (bumpRev or FOR UPDATE), then lanes/cards; rebalance runs under that lock, so no deadlock between moves.
- Rev: card move stamps rebalanced rows with locked rev + 1, equal to the rev the CTE commits; lane move uses the bumpRev value. `/changes` lists them or reports `truncated` (cap 300) and the client reloads.
- Position columns are COLLATE "C" (migration), matching the JS comparison in position-key.ts.
- position-key.ts: PASS. Equal / reversed / invalid / over-48-char keys give null. Front/end inserts in keyAfter skip the length check (grows about 1 char per 62 inserts, far below 64); low priority.
- chat.ts pulse (read only, not edited): scoping is correct (own membership, live workspaces, board chats gated by visibility/seat/admin, no inbox). Notes: (a) archived boards are not excluded from board chats in pulseWhere (check against the conversation list rule); (b) ordering by `conversation.updatedAt` needs an index on conversations (updated_at) or the relation sort scans the member's rows; bounded by PULSE_CAP and 200 workspaces.
- invite-email.ts / templates.ts: PASS. Payload holds only a sealed address+token bound to the inviter; run-time re-check of inviter role and workspace state; stale-token skip; idempotency key; no address logged; HTML escaped, links escaped, bidi isolated.
- seed-guard.ts: PASS (exact hostname match, no leak). Note: a `*_demo` / `*_test` database name is accepted on any host by design.

## Performance
- Rebalance is 1 read + 1 UPDATE (no per-row queries); card move is about 6 round trips worst case (lock, find, rebalance 2, find, CTE). Indexes `(workspace_id, lane_id, position, id)` and `(workspace_id, board_id, position, id)` serve the reads.

## Tests
- Added tests/position-key.test.ts (5 unit tests, passing). Integration tests not run (per instructions).
