# Review 7: authorization-first pass over src/server (security)

Scope: routes/*, workspaces.ts, entitlements.ts, payments-hooks.ts, background.ts, memberships.ts, files.ts. Items already fixed or accepted in reviews 2 to 6 are not repeated.

## Fixed
- boards.ts `PATCH /boards/:id`: a share link survived a visibility change. Setting a shared board to private/workspace (by PATCH, not by DELETE /share) left `share_token_hash` in place; a later PATCH back to `public` by any board admin (no `site:board:share` permission needed, no rotation) silently re-activated the old, possibly leaked link. The PATCH now clears `share_token_hash` whenever `visibility` is set to anything but `public`. The public route's uncached link check already reads the hash, so the effect is immediate.

## Verified OK
- Workspace/board scoping: every `:id` route goes through `requireWorkspaceRole`, `boardAccess`, `boardFor/laneFor/cardFor`, `cardCtx/viaCard`, `conversationAccess` or an owner-in-where query (notifications, saved filters, import start record, memberships). Child rows (labels, checklists, items, comments, attachments) are reached through their card with membership in the `where`, then `boardAccess` and a workspace equality check. Cross-board label / lane / assignee ids are checked against the card's board and workspace.
- Role rules (members.ts): `canManageMember` / `canGrant`, owner never grantable, role change and removal conditional on the role read, last-owner check in the transaction, transfer under the workspace lock, archive/restore carry the owner role in the `where`.
- Invites and join links: tokens 32 random bytes, stored as SHA-256, miss rate limit per user, email-bound invites need a VERIFIED address, admin-role links die with their maker's rank, removal marker blocks old links, seat taken by a conditional update. Email only ever in the sealed job payload; lists show `boundToEmail`.
- Mass assignment: all bodies go through validators with field-by-field copies; `PATCH /boards/:id` strips `lanes`; checkout metadata drops `workspaceId` / `plan`; `customerRef` is set only by the server, so a browser cannot make a plan checkout or name a workspace.
- Payments hooks: idempotent upserts, event-time ordering, plan = highest granting membership, refund cancels only when exactly one candidate matches. Plan price keys are refused on the generic checkout.
- SQL: every raw query is tagged / `Prisma.sql` / `Prisma.join`; no `Unsafe`, no `Prisma.raw`, no string-built SQL (grep clean).
- Email/secret leaks: member lists mask addresses, search, chat pickers, notifications, public board (`publicName`) and export return names only; the public board answers one generic 404, rate limits views and misses per hashed IP.
- Files: attachment type allow-list, size/quota checks before the grant, view goes through access check then a 5-minute link, link attachments are http(s) only without credentials.
- Background jobs: handlers load by id, no secrets in payloads (reviewed in review 6).

## Minor, not changed
- `PATCH /boards/:id` also works on a person's own personal Inbox board (they are its board admin): they can rename, archive or change its visibility. Self-inflicted and the Inbox stays invisible to others (`boardAccess` + `inbox_of IS NULL` filters), but a guard on `inboxOf` would be tidier (BoardAccess does not expose it yet).
- Workspace cap (`MAX_OWN_WORKSPACES`) counts only non-archived workspaces and `restore` does not re-check it: create, archive, create more, restore all exceeds the cap. Cost/abuse only.
- `POST /site-api/checkout` is rate limited per signed-in user only; anonymous Buy-button starts rely on the platform's own limits (it creates a platform checkout per call).
- A DM whose other person left and rejoined: `POST /conversations` returns the existing DM but does not re-add the rejoining user's `conversation_members` row, so they get 404 on it (function, not leak).
- Ownership transfer does not require the target to be an active user (the target is a current member, so low risk).
- Chat mention notifications are inserted directly (not through `notify()`), so they skip its per-actor hourly cap; the per-minute / per-hour send limit still bounds them.

## Tests
- `tests/board-share.test.ts`, `tests/guard-server-rules.test.ts`, `tests/review5-boards.test.ts` pass. Integration tests not run (no database). Suggested integration case: share, PATCH visibility workspace, PATCH visibility public, old link must answer 404.
