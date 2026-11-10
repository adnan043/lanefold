# Performance review 5

Date 2026-11-04. Scope: `src/server/**`, `src/app/**`, `prisma/schema.prisma`. Code reading only; no code changed, no tests, no build, no migration. Not repeated: `review-performance*.md`, `review-render-perf.md`, `review-bundle.md`, `review-query-plans.md` (in `docs/product/reviews/`).

## Fixed
Nothing. No new issue met the bar for a change.

## Verified OK (new since the earlier reviews)
- `public-board.ts`: one uncached link check by token hash (unique index), then content cached by `pubboard:<id>:<rev>` with `delPrefix` on share changes; nested reads are bounded by `take`; one user read for names, bounded. Misses and views are rate limited before any query.
- `card-detail.ts` `/cards/:id/detail`: 7 reads in one `Promise.all`, then one names read; every list bounded by `LIMITS`.
- `billing.ts`: plan ladder goes through `cache.getOrSet` and is cleared by `cache.del` on save (the earlier "skipped" item is done). `entitlements.ts`: settings via `getOrSet` with `invalidateAppSettings`, per-request memo, one joined read.
- `search.ts` `/my-day` and `/search`: one query each (people, boards and cards in parallel), all with LIMIT and keyset; `my-day` uses the `card_members(user_id, workspace_id, card_id)` index.
- `members.ts` directory, `boards.ts` workspace and board lists, `notifications.ts` list (SCAN-bounded): keyset paging, `take`, explicit `select`. No offset paging; `count()` appears only in write paths under a lock or limit check, never on a poll.
- Schema: every lookup by token or slug is on a `@unique`; every list shape found has a matching `@@index` (workspaces `created_by`, `audit_events(actor,action,id desc)`, notifications, messages, cards, comments). No new index or migration warranted.
- Client: polling is visibility-aware (bell 30 s, chat pulse 3/12/30 s with jitter and error back-off, TanStack pauses hidden tabs); `staleTime` is set on every query; the only third-party imports under `src/app` are react and react-dom, and heavy widgets load through `createLoader`.

## Minor, not changed
- `notifications.ts` GET `/notifications`: the workspace-membership read runs before the list query (2 sequential round trips). It could be an inline `IN (SELECT ...)`; low value at 1 request per bell open.
- `members.ts` directory: the user read depends on the page rows, so 2 sequential reads is the minimum without a join; fine.
- `search.ts` card `ILIKE` on `description_md` stays a workspace-scoped scan (known in `review-query-plans.md`; `pg_trgm` index only if workspaces grow large).
- Still open from review 4: notification visibility scan semantics, export's sequential reads, `board-extras` archived-lanes per-row count (max 51 lookups).
