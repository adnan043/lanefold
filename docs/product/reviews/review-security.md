# Lanefold security review (authorization first)

Scope: `src/server/routes/{boards,billing,members,notifications,chat,search,workspace-settings}.ts`, `card-detail.ts` (skimmed), `src/server/{workspaces,entitlements,validation,notifications,general-channel,payments-hooks}.ts`, `src/server/jobs/**`, plus the client spots that render chat, links and redirects. Read-only review; no code was changed.

## Verdict
No Critical or High finding. No cross-workspace IDOR was found. Every id-in-URL route puts workspace membership in the first query (`boardAccess`, `laneFor`, `cardFor`, `conversationAccess`, `ownMessage`, `requireWorkspaceRole`). Body ids (`laneId`, `afterId`, `parentId`, `mentions`, `cardIds`, `userId`) are re-scoped to the workspace, board, lane or conversation in the query. Raw SQL is all tagged `$queryRaw` with parameters. `sameOrigin` and `csrf` are mounted globally in `app.ts` before all of these routes. No email, password or token leaks were found in selects, audit meta or logs.

## CONFIRMED (code path traced)

### 1. MEDIUM, functional + authz: creator of a private board cannot open it
- `src/server/routes/boards.ts:554-577` (create board) never inserts a `board_members` row for the creator.
- `src/server/workspaces.ts:89-94` (`resolveBoardRole`): a workspace `member` with visibility `private` and no override resolves to `null`, so `boardAccess` returns null and the board answers 404.
- No route anywhere writes `boardMember` (grep), so private boards are usable only by workspace owners and admins.
- Exploit: a plain member creates a private board and immediately gets 404 on it. It is not a leak, it fails closed, but the private-board and board-override feature is dead.
- Fix: in the create transaction add `tx.boardMember.create({data: {boardId: row.id, workspaceId, userId, role: 'admin'}})` for private boards (or for every board).

### 2. MEDIUM, business rule: read-only workspaces still accept chat writes
- `src/server/routes/chat.ts` (send, edit, react, pin, create channel, group and DM) never calls `getEntitlements(...).readOnly`.
- Boards, lanes, cards, members, search/inbox and card-detail all do (`boards.ts:370`, `members.ts:320`, `search.ts:286`).
- Exploit: after the grace period a workspace is meant to be read-only, but members can still post to chat and create channels, groups and DMs.
- Fix: check `readOnly` in `requireConversation('write')`, and in the channel/group/DM branch of `POST /workspaces/:id/conversations`. Answer 409 `workspace_read_only`.

### 3. LOW-MED, unbounded writes with no cap or rate limit
- `POST /workspaces/:id/boards` (`boards.ts:543`): no per-workspace board cap and no rate limit, up to 10 lanes each.
- `POST /lanes/:id/cards` (`boards.ts:863`): 20 cards per request, unlimited cards per lane and unlimited requests.
- `POST /workspaces/:id/conversations` (`chat.ts:515`): unlimited groups and DMs. Only channels are capped, at 50.
- Exploit: a single member script fills the Site Database (storage and cost abuse). It does not cross tenants.
- Fix: a bounded count per hour per user, as `members.ts` `createdRecently` and the chat send limit already do. Add a per-lane or per-board card cap.

### 4. LOW, email-bound invite does not require a verified email
- `src/server/routes/members.ts:425-428` compares `sha256(viewer.email.toLowerCase())` to `emailHash` but never checks `viewer.emailVerified` (field exists in `platform/types.ts:28`).
- Exploit: someone who has both a leaked invite token and the target address can register that address (unverified) and accept it. Mitigated by the 256-bit token.
- Fix: add `viewer.emailVerified &&` to the bound-invite branch.

### 5. LOW, mention and notification metadata for a private board
- `chat.ts:374-390` `mentionable` allows any workspace member in board chats and channels, not only those who can see the board.
- `chat.ts:718-727` then creates a `message_mention` notification with `boardId` and `conversationId`.
- Exploit: a user without access to a private board receives a notification naming the board id and the actor. It leaks an id only, and the link opens a 404.
- Compare `card-detail.ts` `eligible()`, which does filter by board access. Fix: for `a.kind === 'board'`, filter `ids` through `boardAccess` or use the same `eligible` logic.

### 6. LOW, lane counter race on archive and restore
- `boards.ts:960-986` `archiveCard` uses `ctx.card.laneId`, read before the transaction, for the `cardCount` increment or decrement.
- A concurrent `/cards/:id/move` between the read and the transaction drifts `cardCount` on the wrong lane. Integrity only.
- Fix: re-read `laneId` inside the transaction after `bumpRev` (it holds the row lock).

### 7. LOW, plan sweep can free-ride or never downgrade
- `src/server/jobs/sweeps.ts:14-26` matches a subscription to a workspace through "any current owner or admin who holds a membership with the plan's price key", not through the `customerRef` workspace.
- A workspace stays on a paid plan while any admin holds a live membership for that price (for example one bought for another workspace). If the payer left the workspace, it never downgrades.
- The primary path (`applyWorkspacePlan` via `customerRef`) is correct. This is only the backstop.
- Fix: persist `workspaceId` from `customerRef` on `memberships`, and sweep on that.

### 8. LOW, hygiene notes
- `payments-hooks.ts:46,76` copy the buyer email into `orders` and `memberships`. That is template behaviour, but it conflicts with the "never copy emails into your own tables" rule.
- `members.ts` `emailHash` is an unsalted SHA-256. It is never output, but a database leak gives an offline oracle. Consider HMAC with `config.jwtSecret`.

## SUSPECTED (not fully traced or not exploitable as-is)
- `search.ts:163` `ILIKE '%q%'` on `cards.description_md`, with no rate limit and no trigram index. Any member, including a viewer, can run it repeatedly on a large workspace for CPU load. It is bounded by `workspace_id` and `LIMIT 21`. Fix: a per-user rate limit, or title-only search.
- `notifications`: after a user loses access to a board or card, old notifications still list the `boardId` and `cardId` (ids and actor name only). The membership filter is by workspace, not by board.
- `POST /workspaces` (`boards.ts:500`): the 10-workspace cap is count-then-insert, so a race can exceed it slightly.
- The checkout confirm route (`GET /site-api/checkout/:id`, template code, not reviewed) runs the payment hooks. Confirm it checks that the checkout belongs to the viewer.
- Billing checkout (`billing.ts:137`) has no rate limit (admin-only, one platform call each).

## Checked and OK
- **Guard order:** `validator, withViewer, requireAuth, withDb, requireWorkspaceRole`. Board, lane and card routes check access with `boardFor`, `laneFor` and `cardFor`. Not a member, or a missing id, is 404. A member below the needed role is 403. Archived board or workspace read-only is 409.
- **Viewer-write path:** `resolveBoardRole` lets a board override beat the workspace role (a workspace viewer with a board `member` or `admin` override can write). This is intended. No route can create an override today (finding 1), so it is only reachable by direct database edit. Nothing escalates from it.
- **IDOR through body ids:**
  - `afterId` is resolved through finders bound to the lane or board and workspace.
  - Card move `laneId` must be a live lane of the same board and workspace.
  - Chat `parentId` is bound to the conversation and workspace.
  - `mentions` and DM `userIds` are intersected with workspace or conversation members.
  - Chat `cardIds` are bound to the workspace only, and the client never resolves them, so only ids are stored.
  - Triage requires my own Inbox card, a lane of the same workspace, and `boardAccess(...).canWrite`.
- **Mass assignment:** all writes are built field by field from validators. `ownerId`, role, plan and counters are server-set.
- **Members and invites:**
  - Tokens are 32 random bytes, stored as SHA-256 only, shown once, and every invalid case returns the same 404.
  - Link use, seat take and member insert happen in one transaction. The cap is a conditional `member_count < limit` update.
  - Remove, leave and transfer take a `FOR UPDATE` lock on the workspace row. The last owner cannot leave. Role changes are conditional on the role that was read.
  - Nobody can grant `owner`. The privilege ladder is enforced by `canManageMember` and `canGrant`.
- **Emails:** the member directory returns names, plus a masked email only to admins and owners. Notifications, chat, search and my-day return names only.
- **Admin-only routes:** gated by `requirePermission` on catalogue codenames (`BILLING_MANAGE` and `PLANS_MANAGE` are owner-only, `WORKSPACE_READ` is admin and audited).
- **Checkout:** a workspace plan changes only through the platform's signed membership events. The price comes from `plan_limits` by key, and `customerRef` (`userId:workspaceId`) is set server-side. The generic checkout route sets `customerRef` to the viewer id only, so a user cannot forge a workspace.
- **Jobs:** keyset paged, bounded, idempotent. `cleanupOld` clamps the retention input.
- **Client XSS:** the chat renders through React text nodes. The linkify regex is `https?://` only, with `rel="noopener noreferrer"`. Attachment links are validated to http or https server-side, with no credentials in the URL. There is no `innerHTML`, `dangerouslySetInnerHTML` or `set:html` with user data in `src/app`.
- **Open redirects:** `nextPath` (`src/lib/account.ts`) is the same-site-path check and mirrors `safeNext`. Notification and billing redirects are same-site (`/checkout/?id=`). `window.location` targets are built from `pathname` and `search`.
- **CSP:** the only `style={}` uses are the dnd-kit transform in `src/app/boards/card.tsx:114` and `lane.tsx:86`. React applies them through CSSOM, which `style-src` does not block, so this is fine.
- **Join token in the URL:** `/app/join/<token>` does not join on load (the user presses the button). Referrer is `strict-origin-when-cross-origin`. The token is not stripped from history; this is minor.

## Not covered
Tests were not run and the build was not run. `card-detail.ts` was skimmed only (assign, comments, attachments, the file-view redirect), and it was mid-edit.
