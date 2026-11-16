# Performance review 7 (full pass)

Date 2026-11-16. Scope: everything — DB queries and indexes, background jobs and flows, sync and polling, React
screens, page load (CSS, fonts, caching). Also the uncommitted performance work already in the tree. Typecheck,
build, all unit tests (1491) and the integration files for every touched route/job (16 files, 351 tests) pass.
Query plans were measured with EXPLAIN ANALYZE on a throwaway database (2M notifications, 1.5M audit events).

## Fixed now
1. **Unread bell badge / unread list** (`routes/notifications.ts`): `user_id = $1 AND read_at IS NULL ORDER BY id DESC`
   sorted ALL of a person's unread rows before the LIMIT (`IS NULL` gives no order from `(user_id, read_at, id)`).
   New partial index `notifications_user_unread_idx (user_id, id DESC) WHERE read_at IS NULL`
   (migration `20261116140000`). Measured, 3.3k unread: 24 ms -> 0.24 ms, per person every 30 s.
2. **Workspace audit log, board branch** (`routes/workspace-audit.ts`): the JOIN walked `audit_events` newest first
   across every tenant. Now `CROSS JOIN LATERAL` per board on `(target_type, target_id, id)`. Measured 12 ms -> 1.1 ms.
3. **Card cover images** (`routes/card-detail.ts` `/attachments/:id/view`): inline views answer `private, max-age=60`
   (as the board background does) instead of `no-store`: a board re-render no longer costs a Worker call per cover.
   Downloads and errors stay `no-store`.
4. **Locale fonts** (`styles/i18n.css`): system families first, self-hosted `LF Noto *` last, as the file header always
   said. zh/ja/ko/ar/bn/hi/th users on macOS/Windows no longer download 100–260 KB of Noto.
5. **brand.css link** (`server/page.ts`, `routes/branding.ts`, `platform/request-scope.ts`): `brandCssHref()` is
   memoized per request and started inside `pageContext`'s `Promise.all`: one serial cache read less per on-demand page.
6. **/app/boards open** (`app/routes.tsx`): with a remembered workspace, its boards load beside the workspace list.
7. **"Archive all cards" animation** (`app/motion.ts` `leaveAll`): reads every size, then starts every animation
   (was read/write per card: one forced layout per card).
8. **Chat "create card" dialog** (`app/chat/create-card-dialog.tsx`): `select`s only board name/flags and lane ids/names,
   so a card move on that board no longer re-renders it.
9. **Calendar view** sensor options are module constants (were rebuilt every render, as fixed in canvas earlier).
10. **Workload** (`routes/board-workload.ts`): `card_members` joined with `workspace_id`, so it reads only this
    workspace's assignments.
11. **Notification emails** (`jobs/notification-email.ts`): candidates ordered by longest wait (`email_notified_at NULLS
    FIRST`), not `user_id`: past 200 due people/hour, high ids were never mailed.
12. **Unread notification sweep** (`jobs/sweeps.ts`, uncommitted work): batches resume past the last deleted id.
13. **Checklist item reminders** (`routes/card-detail.ts`, `soft-limit.ts` `softTake`): one limiter read + write per
    batch, not one get + set per item in sequence.
14. `public/_headers`: `/logo.svg`, `/favicon.svg`, `/icons/*` cached a day + stale-while-revalidate (no rule before).

## Uncommitted work checked
No regressions. Lazy CJK font sheet, lazy create-card dialog, 2-char search skipping descriptions and brand.css
`max-age=60` are good. Note: `lane.tsx`'s vertical observer only acts inside `.lf-swim`, and `Swimlanes` is not
mounted anywhere today, so it is inert.

## Left open (bigger changes; ordered by value)
- **Polling cost**: each poll opens a DB connection and re-checks the session (2 queries) before its own query. A board
  with chat open is ~35 requests/min/tab. One combined poll (board rev + pulse + unread count) would cut that ~3x.
- **Chat window refresh** refetches the newest 50 messages every 20 s with no idle backoff (`use-message-feed.ts`).
- **Chat list** keeps every row once the reader scrolls up (2k messages = 2k rows); `@tanstack/react-virtual` is installed.
- **`/cards/refs` per message** (`chat/card-chip.tsx`): up to 50 requests per page; return refs with the messages page.
- **`/boards/:id/field-values`**: refetched on every board `rev`, capped at 5000 values (silently drops cards on big boards).
- **Retention throughput**: the daily sweep deletes at most 10k read + 10k unread notifications; at ~1k active users the
  table outgrows it. Make it time-budgeted or hourly.
- **Morning digest**: hard 5,000 opted-in ceiling; claimed digests whose email misses the 55 s budget are lost.
- **Recurring cards**: 200 rules/hour cap; checklist copy inside the board lock.
- **Lane bulk actions** (`lane-actions.ts`): reads run after `bumpRev` takes the board lock.
- **Card search**: trigram indexes are global (cross-tenant bitmap). A `(workspace_id, title)` GIN needs `btree_gin`;
  check the host allows it.
- **/app CSS**: ~22 KB gzip of lazy screens' CSS is linked up front (Astro hoists it). Card covers have no stored size
  (layout shift as they load). Lane `backdrop-filter: blur` on photo boards may cost frames on low-end devices.
- `db-socket.ts` treats read-only `WITH …` queries as writes (serialized, never retried).
