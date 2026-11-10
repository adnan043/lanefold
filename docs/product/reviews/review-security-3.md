# Lanefold security review, round 3 (authorization first)

Read-only. Scope: code added or rewritten after round 2. Findings from rounds 1 and 2 are not repeated.

## Verdict
No Critical or High. No cross-workspace or cross-board IDOR found. Two Low-Medium items and three Low items below.

## Authorization: checked and clean
- `POST /messages/:id/card` (`chat-extras.ts:143-218`): a missing message, an unreadable conversation, a deleted message and a non-user message all answer the same 404, so there is no oracle. The lane is read with `workspaceId = a.workspaceId`, then `boardAccess` (workspace membership in the query, private-board rule, another user's Inbox refused) and `access.workspaceId === a.workspaceId` are checked. A board the user cannot see is a 404, a read-only board is a 403, and the board's name never appears in an error. Every write is scoped by `boardId` and `workspaceId`. The card cannot be attached to another workspace's message: `messageCardRef` takes the new card and `msg.id` from the same checked conversation.
- `GET /cards/refs`: the membership join, the private-board rule and the Inbox rule are all in the WHERE, and the rule matches `resolveBoardRole`. `GET /conversations/:id` and `members/search` have no email, a tagged query and `likeEscape`.
- `GET /boards/:id/archived-lanes` and `POST /lanes/:id/restore`: both go through `boardAccess` and `canWrite`. Every query carries `workspaceId` and `boardId`. The restore updates with `archivedAt: {not: null}`, takes the lane count under the board lock, and answers 404 when the lane is already restored.
- Card move CTE (`boards.ts:994-1040`): the board, the card and both lanes are bound by `id`, `board_id` and `workspace_id`. A lane id from another board or workspace matches no row, so the target `t` is empty and `room` is false, which throws `LaneFull` and rolls back. The cross-board move is not possible. The pre-check `findFirst` also scopes the lane by board and workspace.
- Board open (`boards.ts:633-668`): the lane ids come from `db.lane.findMany` for that board, not from the client, and every branch carries `workspace_id` and `board_id`. The `' UNION ALL '` separator is a constant. `cardsAfter` binds `position` as a text parameter (the regex `[0-9A-Za-z]{1,64}` allows no quote), so there is no injection.
- `card-faces.ts`: three prepared statements. Labels are scoped by `l.workspace_id`, assignees by `cm.workspace_id`, the cover by `a.workspace_id = c.workspace_id`. The card ids come from an already authorized page. No email is selected.
- `soft-limit.ts`: the name is always a literal in the code (`checkout`, `search`, `invite-miss`) and the key is `userKey(userId, ...)`, so one user cannot touch another user's counter. The only abuse is the documented lost update under a burst.
- `cleanupOld` (`jobs/sweeps.ts:127-150`): `fileId` is written only from the `createUpload` grant (`card-detail.ts:884`) and never taken from the client. The selected rows are `ready=false`, older than 1 day, and the delete is `ready:false` only. A forged file id cannot reach the platform delete. The cover is set only from an attachment of the same card (`card-detail.ts:1005`).
- `recordMembership` and `customerRef`: the workspace id is built only in `billing.ts:171` as `${viewer.id}:${workspaceId}`, behind `requireWorkspaceRole('admin')` on that same `workspaceId`. The generic `checkout.ts:163` sends only `String(viewer.id)` and an anonymous buyer sends no reference. The client's `metadata` is never read by the hooks. `refParts` is strictly digits (`^\d{1,10}$`). A buyer cannot name a workspace they do not administer.
- Preferences GET and PATCH: only `viewer.id`, with allow-lists for every field.

## Findings

### 1. LOW-MEDIUM, a removed or demoted member can still cancel a workspace's plan (CONFIRMED by reading)
- `src/server/routes/checkout.ts:252-262` (`/memberships/:id/cancel`). The ownership check is `ownedBy(viewer)` (the buyer's `userId` or verified email) with no check of the buyer's CURRENT role in `membership.workspaceId`. After the cancel, `applyWorkspacePlan` runs at once (`:262`).
- Exploit: an admin buys the Pro plan for workspace W, is later demoted or removed (or leaves on bad terms), then calls `POST /memberships/<their subscription id>/cancel {atPeriodEnd:false}`. W falls back to Free immediately and the grace clock starts for any limit it is over.
- Fix: add `workspaceId: true` to `memberSelect` and the `findFirst`, and when it is set require `membership(db, workspaceId, viewer.id).rank >= 3` (else 403 or 404). Alternatively, let only the owner cancel, and offer the former buyer the cancel from the platform.

### 2. LOW, card move and card-from-message can place a card in a lane that was archived in the meantime (CONFIRMED by reading, race only)
- `boards.ts:1004-1010` (the `t` step) and `chat-extras.ts:201-205` update `lanes` with `id`, `board_id` and `workspace_id` but no `archived_at IS NULL`. The `archivedAt: null` check happens earlier, outside the transaction (`boards.ts:957`, `chat-extras.ts:161`).
- Exploit: two members race: one archives lane L while another moves a card into L. The card is then in an archived lane and is hidden from the board, with an inflated `card_count`. It is not a leak, it is hidden data.
- Fix: add `AND lanes.archived_at IS NULL` to the `t` update, to the `UPDATE lanes` in chat-extras, and to the same step in `POST /lanes/:id/cards` if it does not have it.

### 3. LOW, a cursor id above 2^31 makes `/lanes/:id/cards` answer 500 (SUSPECTED, not run)
- `boards.ts:508` allows `\d{1,10}`, and `cardsAfter` (`boards.ts:127`) casts `${cursor.id}::int`. `after=a|9999999999` should raise Postgres "integer out of range", so any signed-in user who can read a lane gets a 500 and an error log line. No data leaks.
- Fix: reject `Number(m[2]) > 2_147_483_647` as `invalid` (422), or change the regex to `\d{1,9}`.

### 4. LOW, "Create card from message" copies private text and the private source's name into a board with a wider audience (CONFIRMED, by design but unannounced)
- `chat-extras.ts:174-184`: the description is the message body plus `*From chat: #<channel or board name>*`. The reader of a private board's chat (or a DM or group) can put it on a workspace-visible board, and the name of the private board is written into a card every workspace member can read.
- This is not an access bypass (the reader could copy the text by hand), but the name of the private board is added automatically, and the message author is not told.
- Fix: for `kind = 'board'` use the board's name only when the target board is the same board or has `visibility <> 'private'` is false; otherwise write `a board chat`. Show the dialog a one-line warning when the source is a DM, a group or a private board's chat and the target board is not private.

### 5. LOW, `members/search` returns inactive users and their roles (CONFIRMED)
- `chat-extras.ts:104-111` does not filter `u.status = 'active'`, unlike `card-detail.ts:386,559`. Suspended or deleted members appear in the mention and DM pickers, and `role` is sent to every viewer.
- Fix: add `AND u.status = 'active'`, and drop `role` unless the picker needs it.

## Not a finding
- No rate limit on `POST /messages/:id/card` (only the per-message cap of 10 and the per-lane cap). Same as the other card-create routes; note it with round 2's notes.
- `cardsInWorkspace` (`chat.ts:728`) links any card id in the same workspace to a chat message, not only cards the sender may see. The chip is filtered by `/cards/refs`, so readers see only what they may; the sender can only learn that an id exists in the workspace.
- Client dialogs (`create-card-dialog.tsx`, `archive-panel.tsx`): ids come from API lists, the route re-checks every one, and all text renders as text nodes.
