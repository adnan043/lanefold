# Query-plan review: indexes under volume

Date 2026-11-03. Database: LOCAL `lanefold_test` only (never `lanefold`). Method: a throwaway schema `qp` (tables copied from `public` without data, same indexes replayed from `pg_indexes`), bulk-loaded with `generate_series`, `VACUUM ANALYZE`d, queried with `EXPLAIN (ANALYZE, BUFFERS)` (median of 3 warm runs, parameters bound like Prisma does), then `DROP SCHEMA qp CASCADE` (verified gone; no pg_trgm left behind). Scripts live in the session scratchpad (`qp-gen.mjs`, `qp-queries.mjs`, run under `flock db.lock`). Queries are copied from the routes (board open, lane page, changes, search, My Day, inbox, chat pulse/messages, unread count, notifications, card faces, card refs, members); Prisma `findMany` calls are written as the SQL Prisma emits.

## Datasets
- **1x**: users:5000, workspaces:50, workspace_members:10000, boards:1200, board_members:500, board_stars:5000, lanes:2001, cards:105000, card_members:163628, labels:2000, card_labels:150000, comments:20000, conversations:500, conversation_members:50000, messages:300000, message_card_refs:15000, notifications:200000, attachments:5337.
- **10x** (every table x10, plus the "whale" entities x10 as well: one board with 200k open cards, one chat of 1M messages, one user with 200k notifications / ~54k assignments): users:50000, workspaces:500, workspace_members:100000, boards:12000, board_members:5000, board_stars:50000, lanes:20001, cards:1005000, card_members:1553713, labels:20000, card_labels:1500000, comments:200000, conversations:5000, conversation_members:500000, messages:3000000, message_card_refs:150000, notifications:2000000, attachments:50429.
- Shape: 4 boards per workspace (25% private), 10 lanes per board, 10% archived cards, 20% completed, skewed "whale" workspace 1 / user 1 / conversation 1. All data is hot in cache; PostgreSQL defaults (work_mem 4 MB); parallel query off for the 10x run (conservative).

## The 5 worst queries (at 10x), with fixes (PROPOSED, not created)
1. **#02 Board open, window query on a very large board**: 20 ms (20k open cards) -> **350 ms, 15 MB sort spilled to disk** (200k open cards). The planner takes a Bitmap scan on `cards_board_id_updated_rev_idx` and sorts ALL open cards of the board to apply `row_number() OVER (PARTITION BY lane_id)`; the partial open index is ignored for the whale board (it is used for a 500-card board, 1.1 ms). Not an index gap: a query-shape problem. Fix in `src/server/routes/boards.ts`: read the lanes first (already done, max 50), then one `UNION ALL` of per-lane `(SELECT ... WHERE workspace_id=$1 AND board_id=$2 AND lane_id=$n AND archived_at IS NULL ORDER BY position, id LIMIT 16)` (as `Prisma.sql` + `Prisma.join`/`Prisma.sql` fragments; lane ids as parameters). Measured **0.2-0.3 ms at 1x and 10x**, 160 rows scanned, uses `cards_board_id_lane_id_position_id_open_idx`. A `CROSS JOIN LATERAL` version is 0.2 ms at 10x but 13 ms at 1x (the planner flips to a bitmap scan on skewed lanes), so use the UNION ALL.
2. **#12 Card search ILIKE, selective/no-match term in a big workspace**: 57 ms -> **517 ms** (186k rows read, 46k buffers). ILIKE '%x%' cannot use a btree: it walks every open card of the workspace until 21 hits, so rare terms read everything. Typical workspace (2k cards): 4 -> 6 ms, fine. Fix: trigram GIN (measured **0.1 ms at 1x, 8 ms at 10x**):
   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE INDEX cards_title_trgm_idx ON cards USING gin (title gin_trgm_ops);
   CREATE INDEX cards_description_md_trgm_idx ON cards USING gin (description_md gin_trgm_ops);
   ```
   Cost: large index on `description_md` (up to 20 KB per card) and slower card writes; check that the platform's Site Database allows `CREATE EXTENSION pg_trgm` first. Common terms ("task") stop early at 21 hits and gain nothing. Alternative with no extension: index only `title` and drop `description_md` from the search.
3. **#16 My Day for a heavy assignee**: 48 ms -> **470 ms** (617k buffers) for a user with ~54k assignments (5k at 1x). Typical user 0.3 ms. The query must read every open assigned card to order by due date; the `card_members(user_id, workspace_id, card_id)` index is used correctly. A MATERIALIZED CTE driving from `card_members` (#16b) only trims it to 409 ms. Not fixable with a plain index; options: (a) accept (only users with tens of thousands of open assignments), (b) bound it by a due-date window (overdue + next 14 days) so a partial index `cards(workspace_id, due_date) WHERE archived_at IS NULL AND completed_at IS NULL` can drive it, (c) denormalise `due_date` onto `card_members` with an index `(user_id, due_date, card_id)`. Product decision, flagged not proposed as SQL.
4. **#32 Notifications list filtered to a workspace the user has few rows in**: 14 ms -> **216 ms** (2M rows walked on `notifications_pkey` backwards, filtering `user_id`/`workspace_id`). The unfiltered list, the unread filter and the unread count are all fine (0.03-0.1 ms). Fix (**0.01-0.04 ms**):
   ```sql
   CREATE INDEX notifications_user_id_workspace_id_id_idx ON notifications (user_id, workspace_id, id DESC);
   ```
   (Prisma form: `@@index([userId, workspaceId, id(sort: Desc)])`.) Keep `(user_id, id DESC)` for the unfiltered list.
5. **#05 Lane page, keyset cursor written with OR**: 0.2 ms -> 1.0 ms; reads *every remaining card of the lane* (1678 rows at 10x, grows linearly with lane length) and top-N sorts them, because `position > p OR (position = p AND id > i)` becomes a BitmapOr. Row comparison reads only 31-34 rows (**0.03-0.07 ms**, same index `cards_workspace_id_lane_id_position_id_idx`). Fix in raw SQL: `AND (position, id) > ($3, $4)`. No migration. (Runner-up #45 archived cards: 0.8 -> 1.6 ms, scans 6.3k cards via `cards_pkey` filtering on archived; partial index below makes it 0.04-0.08 ms, 31 rows.)

### Proposed migration (not created; needs `BEGIN/COMMIT` per repo convention, so no `CONCURRENTLY`; fine while tables are small)
```sql
BEGIN;
CREATE INDEX "notifications_user_id_workspace_id_id_idx" ON "notifications" ("user_id", "workspace_id", "id" DESC);
CREATE INDEX "cards_board_id_archived_id_idx" ON "cards" ("board_id", "id" DESC) WHERE "archived_at" IS NOT NULL;
-- only if the platform allows the extension:
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "cards_title_trgm_idx" ON "cards" USING gin ("title" gin_trgm_ops);
CREATE INDEX "cards_description_md_trgm_idx" ON "cards" USING gin ("description_md" gin_trgm_ops);
COMMIT;
```
Prisma cannot express the partial and GIN indexes: raw SQL only, like `cards_board_id_lane_id_position_id_open_idx`.

## Findings that need no change
- No query seq-scans a large table. The only Seq Scans left are tiny (`conversations` 500 rows at 1x, `workspaces` <= 500 rows, `boards` 1.2k rows in the whale search plan, `users` 5k rows in people search at 1x; at 10x the planner switches the people searches to nested loops, 0.5-1.5 ms). Adding a trigram index on `users.name` was measured WORSE at 10x (9 ms vs 0.5 ms): do not add it.
- No sort spills except #02 (and the same shape in `02c`).
- Chat is the healthiest area: messages by `seq` (latest, before, after, 1M-message conversation) 0.03-0.04 ms using `messages_conversation_id_seq_key`, threads 0.02 ms, pulse 3 reads 0.01-0.05 ms, send rate limits 0.01 ms.
- The cards partial index `cards_board_id_lane_id_position_id_open_idx` exists in `lanefold_test` already (migration applied) and serves the normal board; `cards_board_id_updated_rev_idx` serves the changes feed (0.2-0.4 ms, capped at 301 rows even for since=0).
- Card faces (3 queries x 150 cards) 0.4-2.3 ms, card refs 0.1-0.2 ms, members directory 0.05-0.2 ms, unread count 0.03-0.9 ms (capped subquery), inbox 0.03-0.08 ms, boards list/boardAccess 0.01-0.07 ms.
- Mark-all-read target scan: 20k unread rows 3.5 ms -> 200k rows 29 ms (index-only on `notifications_user_id_read_at_id_idx`); an UPDATE of that size is a one-off, acceptable.

## Caveats
Synthetic uniform-ish data plus three whales; everything was cached, so buffer counts matter more than milliseconds for cold production caches; work_mem is the local default (the sort spill threshold in production may differ); no concurrent writers, so index write overhead of the proposals was not measured.

## Every query, 1x -> 10x
"(alt)" rows are diagnostic or proposed rewrites, not the current code.

| # | Query | Plan (1x) | Index used | 1x ms | 10x ms | Rows scanned/returned (1x -> 10x) | Seq scan / sort spill at 10x | Holds at 10x? |
|---|---|---|---|---|---|---|---|---|
| 01 | board open (typical board, 500 cards) | Limit | cards.board_id_lane_id_position_id_open, cards.workspace_id_due_date_id | 1.39 | 0.83 | 451/160 -> 500/160 | - | yes |
| 02 | board open (WHALE board, 20k+ cards) | Limit | cards.board_id_updated_rev | 20.5 | 349.8 | 20500/160 -> 200500/160 | external merge Disk 15288kB | NO |
| 02b | ALT board open: LATERAL per lane (WHALE) [proposal] | Limit | lanes_workspace_id_board_id_position_id, cards.board_id_lane_id_position_id_open | 13.5 | 0.22 | 18490/160 -> 170/160 | - | (alt) |
| 02c | ALT board open: ORIGINAL window query, bitmapscan off (diagnostic) | Limit | - | 26.17 | 300.12 | 105000/160 -> 1005000/160 | cards (1005000 rows); external merge Disk 15288kB | (alt) |
| 02d | ALT board open: LATERAL, bitmapscan off (diagnostic) | Limit | lanes_workspace_id_board_id_position_id, cards.board_id_lane_id_position_id_open | 0.19 | 0.2 | 170/160 -> 170/160 | - | (alt) |
| 02e | ALT board open: UNION ALL one LIMIT-16 subquery per lane (lane ids known) [proposal] | Append | cards.board_id_lane_id_position_id_open | 0.2 | 0.31 | 160/160 -> 160/160 | - | (alt) |
| 03 | board open: lanes | Limit | lanes_workspace_id_board_id_position_id | 0.01 | 0.02 | 10/10 -> 10/10 | - | yes |
| 04 | lane page, first page (whale lane) | Limit | cards.workspace_id_lane_id_position_id | 0.04 | 0.04 | 35/31 -> 35/31 | - | yes |
| 05 | lane page, deep cursor (whale lane) | Limit | cards.workspace_id_lane_id_position_id | 0.23 | 1.04 | 388/31 -> 1678/31 | - | yes |
| 05b | lane page, EARLY cursor (OR form) (whale lane) | Limit | cards.workspace_id_lane_id_position_id | 0.05 | 0.1 | 69/31 -> 69/31 | - | yes |
| 05c | lane page, EARLY cursor, row-comparison form [proposal] | Limit | cards.workspace_id_lane_id_position_id | 0.03 | 0.07 | 34/31 -> 34/31 | - | (alt) |
| 06 | changes feed cards, since=990 (whale board) | Limit | cards.board_id_updated_rev | 0.4 | 0.44 | 188/188 -> 301/301 | - | yes |
| 07 | changes feed cards, since=0 (full catch-up, whale) | Limit | cards.board_id_updated_rev | 0.28 | 0.44 | 301/301 -> 301/301 | - | yes |
| 08 | changes feed lanes, since=990 | Limit | lanes_board_id_updated_rev | 0.01 | 0.04 | 0/0 -> 0/0 | - | yes |
| 09 | search ILIKE, common term "task" (typical ws, member) | Limit | boards_inbox_of_workspace_id, boards_inbox_of_key, board_members_user_id_workspace_id | 4.13 | 5.58 | 2853/21 -> 3784/21 | - | yes |
| 10 | search ILIKE, rare term hit (typical ws) | Limit | boards_inbox_of_workspace_id, boards_inbox_of_key, board_members_user_id_workspace_id | 3.96 | 5.41 | 1505/1 -> 2007/1 | - | yes |
| 11 | search ILIKE, NO match (typical ws, scans all) | Limit | boards_inbox_of_workspace_id, boards_inbox_of_key, board_members_user_id_workspace_id | 4.04 | 5.82 | 1504/0 -> 2006/0 | - | yes |
| 12 | search ILIKE, NO match (WHALE ws 1, admin sees all) | Limit | cards.board_id_updated_rev, cards.workspace_id_due_date_id, lanes_pkey | 57 | 516.8 | 28200/0 -> 186379/0 | - | NO |
| 13 | search boards ILIKE | Limit | boards_inbox_of_workspace_id, board_members_user_id_workspace_id | 0.03 | 0.03 | 4/3 -> 5/4 | - | yes |
| 14 | search people ILIKE | Limit | workspace_members_pkey | 3.44 | 0.47 | 5200/8 -> 400/8 | - | yes |
| 14b | ALT people search: members first (OFFSET 0 fence) [proposal] | Limit | workspace_members_pkey | 2.21 | 0.48 | 5200/8 -> 400/8 | - | (alt) |
| 15 | My Day (typical user) | Limit | card_members_user_id_workspace_id_card_id, workspace_members_user_id_workspace_id, cards.pkey | 0.37 | 0.28 | 118/10 -> 108/16 | - | yes |
| 16 | My Day (WHALE user, thousands of assignments) | Limit | workspace_members_user_id_workspace_id, boards_workspace_id_archived_at_id, board_members_user_id_workspace_id | 47.91 | 470.17 | 30330/201 -> 247757/201 | workspaces (500 rows) | NO |
| 16b | ALT My Day: drive from card_members (MATERIALIZED CTE) (WHALE user) [proposal] | Limit | card_members_user_id_workspace_id_card_id, workspace_members_user_id_workspace_id, cards.pkey | 26.73 | 408.71 | 24287/201 -> 302206/201 | workspaces (500 rows) | (alt) |
| 17 | inbox: find board | Limit | boards_inbox_of_key | 0.01 | 0.01 | 1/1 -> 1/1 | - | yes |
| 18 | inbox: cards (5k open cards in inbox) | Limit | cards.pkey | 0.08 | 0.04 | 66/51 -> 77/51 | - | yes |
| 19 | chat pulse: my memberships | Limit | conversation_members_user_id_workspace_id_conversation_id | 0.06 | 0.02 | 10/10 -> 10/10 | - | yes |
| 20 | chat pulse: conversations by id | Seq Scan | - | 0.05 | 0.02 | 500/10 -> 10/10 | - | yes |
| 21 | chat pulse: still in workspace | Index Only Scan | workspace_members_user_id_workspace_id | 0.01 | 0.01 | 2/2 -> 2/2 | - | yes |
| 22 | messages page latest (WHALE conv, 100k msgs) | Limit | messages_conversation_id_seq_key | 0.04 | 0.03 | 54/51 -> 54/51 | - | yes |
| 23 | messages page before seq=50000 (WHALE) | Limit | messages_conversation_id_seq_key | 0.03 | 0.04 | 53/51 -> 53/51 | - | yes |
| 24 | messages poll after seq (WHALE) | Limit | messages_conversation_id_seq_key | 0.04 | 0.04 | 54/51 -> 54/51 | - | yes |
| 25 | messages thread page (parent_id = X) | Limit | messages_conversation_id_parent_id_id | 0.02 | 0.02 | 1/1 -> 1/1 | - | yes |
| 26 | messages send rate-limit (sender, last 60s) | Limit | messages_sender_id_created_at | 0.01 | 0.01 | 0/0 -> 0/0 | - | yes |
| 27 | messages send rate-limit (sender, last 1h) | Limit | messages_sender_id_created_at | 0.01 | 0.01 | 0/0 -> 0/0 | - | yes |
| 28 | unread count (WHALE user, 20k notifs) | Aggregate | notifications_user_id_read_at_id | 0.96 | 0.08 | 100/1 -> 1000/1 | notifications (1000 rows) | yes |
| 29 | unread count (typical user) | Aggregate | notifications_user_id_read_at_id | 0.03 | 0.02 | 0/1 -> 0/1 | - | yes |
| 30 | notifications list (WHALE user) | Limit | notifications_pkey | 0.03 | 0.05 | 201/21 -> 201/21 | - | yes |
| 31 | notifications list unread only (WHALE user) | Limit | notifications_pkey | 0.03 | 0.04 | 201/21 -> 201/21 | - | yes |
| 32 | notifications list, other-workspace filter (WHALE user, ws 8 has ~0) | Limit | notifications_pkey | 14.43 | 215.93 | 200000/0 -> 2000000/0 | - | NO |
| 33 | notifications read-all UPDATE target scan | Index Only Scan | notifications_user_id_read_at_id | 3.54 | 29.49 | 20000/20000 -> 200000/200000 | - | watch |
| 34 | card faces: labels (150 cards) | Incremental Sort | card_labels_pkey, labels_workspace_id_board_id_id | 0.43 | 0.51 | 265/225 -> 265/225 | - | yes |
| 35 | card faces: members (150 cards) | Incremental Sort | card_members_pkey | 2.29 | 1.34 | 5259/259 -> 546/273 | - | yes |
| 36 | card faces: covers (150 cards) | Hash Join | cards.pkey, attachments_workspace_id_message_id_id | 0.75 | 0.35 | 1602/7 -> 150/5 | - | yes |
| 37 | card refs (30 ids) | Limit | workspace_members_user_id_workspace_id, cards.pkey, boards_pkey | 0.12 | 0.21 | 61/30 -> 61/30 | - | yes |
| 38 | members directory page 1 | Limit | workspace_members_pkey | 0.06 | 0.08 | 51/51 -> 51/51 | - | yes |
| 39 | members directory: users by id | Index Scan | users_pkey | 0.04 | 0.22 | 50/50 -> 50/50 | - | yes |
| 40 | members search (prefix/word ILIKE) | Limit | workspace_members_pkey | 3.47 | 1.48 | 5200/4 -> 400/6 | - | yes |
| 41 | boards list (member, ws page) | Limit | boards_inbox_of_workspace_id, board_members_user_id_workspace_id, board_stars_pkey | 0.03 | 0.07 | 4/3 -> 5/4 | - | yes |
| 42 | boardAccess (membership + board) | Nested Loop | boards_pkey, workspace_members_user_id_workspace_id | 0.01 | 0.02 | 2/1 -> 2/1 | - | yes |
| 43 | workspaces I belong to (by user) | Limit | workspace_members_user_id_workspace_id | 0.01 | 0.02 | 2/2 -> 2/2 | - | yes |
| 44 | card detail comments | Limit | comments_workspace_id_card_id_id | 0.01 | 0.02 | 0/0 -> 0/0 | - | yes |
| 45 | archived cards of board (whale) | Limit | cards.pkey | 0.8 | 1.57 | 6556/31 -> 6341/31 | - | yes |
| 32+ | notifications list ws filter WITH (user_id, workspace_id, id DESC) | Limit | qp_notif_user_ws_id | 0.01 | 0.04 | 0/0 -> 0/0 | - | (alt) |
| 45+ | archived cards WITH partial (board_id, id DESC) WHERE archived | Limit | qp_cards_arch | 0.04 | 0.08 | 31/31 -> 31/31 | - | (alt) |
| 12+ | search NO match (WHALE ws) WITH trigram GIN | Limit | boards_pkey, qp_cards_title_trgm, qp_cards_desc_trgm | 0.1 | 8.04 | 1/0 -> 5/0 | - | (alt) |
| 11+ | search rare hit WITH trigram GIN | Limit | boards_inbox_of_workspace_id, boards_inbox_of_key, board_members_user_id_workspace_id | 4.49 | 4.66 | 1505/1 -> 2007/1 | - | (alt) |
| 09+ | search common term "task" WITH trigram GIN | Limit | boards_inbox_of_workspace_id, boards_inbox_of_key, board_members_user_id_workspace_id | 3.94 | 4.5 | 2853/21 -> 3784/21 | - | (alt) |
| 14+ | people search WITH users.name trigram | Limit | qp_users_name_trgm, workspace_members_pkey | 1.03 | 9.06 | 1566/8 -> 13694/8 | - | (alt) |
