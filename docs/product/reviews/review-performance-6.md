# Performance review 6

Date 2026-11-04. Scope: `src/server/routes/*` and helpers that are NOT being rewritten now (chat, notifications, members, billing, public board, search, board-extras, workspaces list, import/export). Skipped on purpose: custom fields, dependencies, recurring cards, templates, flows, saved filters, share expiry. No build, no full suite, no migration written (no index was needed). Method: scanned every `findMany`, `count`, `skip`, loop and sequential `await` against the schema indexes.

## Fixed now
1. `/chat/pulse` (`routes/chat.ts`, `pulseRows`): the hottest route (a poll per client). It was 3 sequential round trips (my workspaces, then a read of up to 1000 hidden boards over every live workspace, including every member's Inbox board, then the conversations). Now ONE tagged `$queryRaw` that joins my membership rows to live workspaces and applies the board rule (Inbox, or private without a seat unless owner/admin) with a NOT EXISTS, ordered by `updated_at DESC, id DESC`, `LIMIT 200`. Uses `conversation_members(user_id, workspace_id, conversation_id)`. It also removes a correctness edge: the old hidden-board list was cut at 1000 boards. `pulseWhere` / `pulseHiddenBoards` were removed (unused). Tests: `tests/chat-pulse.test.ts` rewritten (one query, bounds, shape); `tests/integration/pulse.test.ts` passes on real Postgres (`lanefold_test`, 2 tests: cap and order, seat loss hides the board chat, channels and DMs stay).

## Checked, nothing to do
- Review 4's open items are already done: notification list and badge are bounded (`SCAN`, `SCAN_CAP`) and the plan ladder is cached (`cache.getOrSet`, `billing.ts`, `pricing.ts`).
- No offset paging, no per-request `count()` of a growing table (the `count()` calls are inside transactions on one board or one user, index-covered). Every `findMany` has `take`. No query inside a loop on a request path (`bumpRev` loop in card move is at most 2 boards).
- Public board: link check uncached, content cached by `board.rev`. Board open: board, lanes and prefs in parallel, then one UNION ALL for cards. Workspace-level reads and conversation list use `Promise.all`.

## Left open (minor)
- `GET /notifications`: workspace read, then the scan (2 trips); could be one query with a join. Low value.
- `search` runs `membership` then `searchLimited` in sequence (2 trips before the parallel reads); could be parallel but the 429 must keep winning after a 404.
- Export still issues many sequential queries per request (see review 4); `sweepPlans` writes per row.
- `pulseRows` has no `workspaces` pre-filter index issue, but `conversations.updated_at` has no index: the sort covers only my own conversations (cap-bound by membership count), so acceptable.
