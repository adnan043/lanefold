# Performance review (read-only)

Top findings, most impactful first. No code changed. Proposed SQL is NOT applied.

1. **Card move holds the board row lock for the whole transaction** (`src/server/routes/boards.ts:927-945`, `bumpRev` at 406-413). `bumpRev` runs first, then about 7 more sequential round trips run inside the same transaction (the `Promise.all` of two reads is serialized on one tx connection; `keyAfter` costs 2-3 finds; then card update, 2 lane updates, activity insert). With `cardFor` before it the request is about 9-10 round trips. Every writer on the board queues behind that lock, and the same pattern is in `archiveCard` and the lane and card create routes. Smallest fix: compute the key and validate lane and card first, call `bumpRev` last, just before the updates (about 5 trips under lock). Merge the two lane `updateMany` calls into one `UPDATE ... CASE`, or one `$executeRaw`.

2. **Polling cost is modest but wasteful.** There is no conditional answer (no ETag or 304) anywhere in `src/server`.
   - `/boards/:id/rev` (boards.ts:711) runs 2 queries per poll. `boardAccess` joins members through `relationJoins`, and `board.findFirst` is a second membership-scoped read of the same row. Two of them are redundant: one query returning both `rev` and the access fields would do. At 5 s plus jitter that is about 12 polls and 24 queries per user per minute. All are primary-key or `workspace_members` PK lookups, so they are cheap.
   - `/chat/pulse` (chat.ts:445) runs 1 query for 20 polls per minute, or 5 per minute when idle (12 s) and 2 when the tab is hidden. The `conversation_members(user_id, workspace_id, conversation_id)` index covers it, `take: 200` caps it, and the response is about 100 bytes per conversation. It re-sends all conversations every time. Cheap fix: add an `?since=<max lastSeq sum>` or ETag so an unchanged answer is a bodyless 304.
   - `/notifications/unread-count` (notifications.ts:89-98) makes 2 sequential queries per call, 2 calls per minute. It fetches up to 100 id rows just to count them. Fix: one `$queryRaw` with `SELECT count(*) FROM (SELECT 1 FROM notifications WHERE user_id=$1 AND read_at IS NULL AND workspace_id = ANY(...) LIMIT 100) t`, with the membership join inline. The existing `(user_id, read_at, id)` index serves it.
   - A user with a board open and chat active costs about 40-45 queries per minute. That is fine for dozens of users but linear. Consider a 10 s base interval for `/rev`, only if latency allows.

3. **Board load query scans the whole board** (boards.ts:604-620). `row_number() OVER (PARTITION BY lane_id ORDER BY position, id)` over all active cards of the board needs a sort. The available indexes are `(workspace_id, lane_id, position, id)` and `(board_id, updated_rev)`, so the planner has no `(board_id, lane_id, position)` path. This is fine up to a few thousand cards per board; beyond that it is a hot path on every board open. Proposed migration:
   ```sql
   CREATE INDEX cards_board_lane_pos_live_idx ON cards (board_id, lane_id, position, id) WHERE archived_at IS NULL;
   ```
   Alternatively use a `LATERAL` per-lane `LIMIT 16` (at most 50 lanes) using the existing `(workspace_id, lane_id, position, id)` index.

4. **Search ILIKE is a seq scan** (`src/server/routes/search.ts:163,173,182`). The cards query uses `c.title ILIKE '%q%' OR c.description_md ILIKE '%q%'` on a column up to 20 000 chars. The only help is the `c.workspace_id` filter (index `(workspace_id, due_date, id)` or `(workspace_id, lane_id, ...)`), so it scans every card in the workspace. This is bounded per request (LIMIT, keyset on id) but it is O(workspace cards) per keystroke. Make sure the client debounces. Proposed migration:
   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE INDEX cards_title_trgm_idx ON cards USING gin (title gin_trgm_ops);
   CREATE INDEX cards_desc_trgm_idx ON cards USING gin (description_md gin_trgm_ops);
   ```
   The cheaper alternative is to drop `description_md` from the OR, or to cap the scan with a title-first query. The people query has the same issue on `users.name`, but it is limited by the workspace_members join, so it is OK. The board name query is OK because the number of boards is small.

5. **Per-request count() / extra reads that could be dropped**
   - `members.ts:273`: `workspaceMember.count` for owners. It is on a rare path and `(workspace_id, ...)` PK serves it. OK.
   - `card-detail.ts:745`: `comment.count` for rate limit, backed by `(author_id, created_at)`. OK, bounded by a 60 s window.
   - `card-detail.ts:576,604,666,834`: `count` before create to enforce limits. These are bounded by the `LIMITS` constants and indexed. Minor.
   - `chat.ts:664-665`: two `findMany` calls per send for the rate limit, each capped by `take`, index `(sender_id, created_at)`. It could be 1 query with `FILTER`. Minor.
   - `boards.ts:500`: `workspace.count({createdBy})` has no `created_by` index on `workspaces`; check it is on a rare path (workspace create only). Minor, but propose `CREATE INDEX workspaces_created_by_idx ON workspaces (created_by);` if the table grows.

6. **Chat message list is not virtualised** (`src/app/chat/conversation-view.tsx:88`, `feed.items.map`). Pages are 50 messages, the row is `memo`'d (`message-item.tsx:257`), but "load older" accumulates without bound in memory and DOM. At a few hundred messages scroll and re-render get heavy. Smallest fix: cap rendered window (for example drop pages more than 300 away from the viewport with `maxPages` on the infinite query) rather than add a virtual list dependency.

7. **Board client re-render hot spots.** `src/app/boards/lane.tsx:127` and `canvas.tsx:224` render every card with `dnd-kit` `SortableContext`. Each card is a sortable item, and the board is capped at about `BOARD_CARD_CAP` cards, so it is bounded. Check that `Card` is `React.memo`'d (no `memo` found in `src/app/boards/*.tsx` except `useMemo` in canvas.tsx:172). A delta from the 5 s poll replaces `board` data through `setQueryData`, so unmemoised cards would all re-render on every change. Add `memo` to the card component and keep the card objects referentially stable in `applyChanges` for untouched cards.

8. **Bundle size** (`dist/client/_astro`, existing build, not rerun). 88 JS files, 1.8 MB total across all files. The main chunks are `client.*.js` 209 KB and `ui.*.js` 106 KB (these are probably React and TanStack plus the kit, loaded on `/app`), and `board-screen` 77 KB (lazy). The i18n locale chunks (about 35-55 KB each, 20+ locales) are separate files. Confirm they are loaded on demand only for the active locale (they are separate chunks, which is right). `chat-screen` is 7 KB and `board-chat` 1 KB, lazy. No major issue. The initial `/app` load is `client` + `ui` + `App.css` (37 KB), roughly 350 KB raw. Fine; check gzip and that the locale for English is not bundled together with the others.

9. **Other index checks, all fine:**
   - `/boards/:id/changes`: `cards(board_id, updated_rev)` and `lanes(board_id, updated_rev)`, bounded by `CHANGES_CAP = 300`.
   - Message pages: `messages(conversation_id, seq)` unique, keyset, no offset. The extra `parent_id` filter is applied on the matched range and is cheap.
   - Notifications list: `(user_id, id desc)`, keyset (`nextBefore`).
   - Cards per lane page: `(workspace_id, lane_id, position, id)`, keyset.
   - No offset paging and no `count()` per poll were found in the poll routes. N+1: none found. `shapeMessages` uses single `IN` queries (`reactionsFor` take 1000, users take 400).

10. **Worker memory and CPU.** No payload over about 50 messages or 300 changed rows is built per request. `reactionsFor` can return 1000 rows (bounded). The `$queryRaw` in the board load returns at most `BOARD_CARD_CAP + 50` rows. No whole-table loops. The sweeps in `src/server/jobs/sweeps.ts` should be checked for `take` and a batch size (not reviewed in depth here).

Not reviewed in depth: `billing.ts`, `checkout.ts`, `jobs/sweeps.ts` internals, and public page weight (marketing pages were not measured; the build has `App.css` 37 KB and `index.css` 8 KB, which look reasonable).
