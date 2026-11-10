# Security review 5: boards, board extras, card detail, saved filters, search

Scope: `src/server/routes/{boards,board-extras,card-detail,saved-filters,search}.ts` plus `workspaces.ts` / `validation.ts` helpers. Authorization first. Earlier findings (review-security-4-boards.md) not repeated unless still open.

## Authorization (all pass)
- Every route: `withViewer, requireAuth, withDb`; object access via `boardAccess()` / `membership()` with workspace membership, archived flag and private-board seat IN the query; no access = 404, 403 only after the board is visible.
- Ids from the client only select: lanes/cards/labels/checklists/items/comments/attachments are reached through the visitor's workspace, then `boardAccess` (viewer write block, archived board 409). Every write `where` carries `workspaceId` and `boardId`.
- Search, My Day, Inbox: SQL repeats the `boardAccess` visibility rule (private seat or owner/admin, foreign Inbox never); ILIKE escaped, tagged `$queryRaw`, rate limited (90/min), bounded, keyset. People answered as id, name, role only: no emails anywhere in scope.
- Saved filters: `userId` + workspace in every where; strict filter schema; board seat re-checked on rename/delete.
- Inbox triage: card must be in MY Inbox; target lane must be in the same workspace and writable via `boardAccess`.
- Body fields built one by one; no `ownerId/workspaceId/boardId` from the client; no `$queryRawUnsafe`.

## Findings
1. LOW, FIXED (open since review 4): `GET /cards/:id/people`, assign and @mention (`seats()`) treated workspace owners/admins as able to see a personal Inbox board, which only its owner can open. The Inbox owner could assign/mention an admin who then got a notification and a 404. Now `seatFilter()` restricts an Inbox card to its owner (`cardCtx` selects `board.inboxOf`).
2. LOW, FIXED: `PATCH /labels/:id` ignored the read-only workspace state (plan limits exceeded) that every other write checks. Update now answers 409 `workspace_read_only`; delete stays allowed (frees space).
3. INFO (no action): `canRestore` for archived boards in `board-extras.ts` trusts a stale `board_members.admin` row; the PATCH re-checks through the viewer clamp.
4. INFO: any member may create `public` boards (by spec); duplicate keeps the source visibility and seats only the creator.

## Tests
`tests/review5-boards.test.ts` (unit, passes): `seatFilter` for Inbox / private / workspace boards, and a static guard that `labelWrite` checks entitlements. Integration tests not run (DB owned by another agent).
