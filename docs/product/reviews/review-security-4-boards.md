# Security review 4: boards, workspace access, card detail, jobs

Scope: `src/server/routes/boards.ts`, `src/server/workspaces.ts`, `src/server/routes/card-detail.ts` (read only), `src/server/jobs/*`.
Authorization first. Result: no exploitable issue found; no source change made.

## Authorization checks (all pass)
- Every route has `withViewer, requireAuth, withDb`; object access comes from `boardAccess()` (workspace membership, `archivedAt: null` and the visitor's seat are IN the query), 404 for no access (no oracle), 403 only after the board is visible.
- `resolveBoardRole`: owner/admin always admin; private board needs a seat; a workspace viewer is clamped to viewer even with an admin override (stale row); personal Inbox only for its owner. `seeableBoards` (lists) matches `boardAccess`.
- Private boards: `/rev`, `/changes`, `/lanes/:id/cards`, `GET /boards/:id`, star, and every card/lane write go through `boardFor`/`laneFor`/`cardFor`, so a member without a seat gets 404.
- Sync leak across boards: `/changes` filters lanes and cards by `workspaceId` AND `boardId` and `updatedRev <= rev`; no cross-board rows. `rev` is only returned after the access check. Output via `select`.
- IDOR via body ids: `laneId` (card move) is looked up with `boardId` + `workspaceId` (other board/workspace => 404); `afterId` is resolved by finders bound to the target lane/board (foreign id => 409 "stale", never used); `workspaceId`/`boardId` in bodies are ignored (validators build fields one by one; created rows take ids from the server).
- Writes carry `workspaceId` + `boardId` in every `where`; raw SQL is only tagged `$queryRaw`; no emails selected.
- card-detail attachments: every attachment/comment/checklist/label route resolves the row through the visitor's workspace, then `viaCard` -> `boardAccess` (private seat, viewer write block, archived board). `/attachments/:id/view` checks access then redirects to a 5-minute link; only `ready` file rows; message attachments (no card) are excluded. `complete` is uploader-only. Link attachments accept http/https only, no credentials. Cover picks an attachment of the same card and workspace.
- jobs: scheduled handlers take no user input except bounded `data` (`keepDays` clamps 7..3650); keyset paging, bounded batches, idempotent. Invite email job payload is AES-GCM sealed (no address/token readable), re-checks invite state, workspace and token hash before sending.

## Findings (none need a fix in boards.ts / workspaces.ts)
1. LOW, card-detail.ts (not edited): `seats()` treats workspace owners/admins as able to see a private board, but a personal Inbox board (`inboxOf` set, private) is visible only to its owner. `eligible()` can therefore let the Inbox owner assign or @mention a workspace admin who cannot open that card (they get a notification and a 404 on the link). Only a name is exposed; no card content. Suggested: in `eligible`/`/people`, for `inboxOf` boards restrict to `u.id = inboxOf`. Needs `inboxOf` in `cardCtx` access.
2. INFO, board-extras.ts (not in scope): `canRestore` for archived boards trusts `board_members.role = 'admin'` without the workspace-viewer clamp. Button visibility only; the PATCH re-checks via `boardAccess`, which clamps. No action needed.
3. INFO: `POST /workspaces/:id/boards` lets any member create a `public` board (visibility not limited to admins). By design per spec, noted.

## Tests
New `tests/integration/review4-boards.test.ts`: pure `resolveBoardRole` clamp (ran, passes); integration cases for private-board 404s across sync/lane/card routes, stale-admin viewer clamp, changes feed isolation, body-id IDOR, and attachment access (skipped here: no `TEST_DATABASE_URL`, not run against Postgres).
