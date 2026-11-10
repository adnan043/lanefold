# Security review 4: chat, chat-extras, notifications, search

Scope: `src/server/routes/chat.ts`, `chat-extras.ts`, `notifications.ts`, `search.ts` (about 30 routes).

## Authorization
- Guards: every route runs validator, withViewer, requireAuth, withDb, then workspace/conversation/board access. No permission codename (workspace-scoped app); access comes from `membership()`, `requireWorkspaceRole`, `conversationAccess`, `boardAccess`. No role-slug gating.
- Object level: `conversationAccess` reads the workspace membership (archived workspace excluded) before anything; DM/group need a `conversation_members` row; board chats follow `boardAccess` (private board, other user's Inbox hidden). Message routes (`ownMessage`) load the message then prove conversation access. Every write carries conversationId + workspaceId in `where`. Not found or not yours: 404. 403 is returned only to someone who already sees the object.
- Read-only workspace: send, edit, react, unreact, pin, create conversation, card-from-message, inbox capture and triage all answer 409; own-message delete deliberately allowed. Archived board chat: canWrite and canModerate are false.
- Notifications: `user_id` in every query; another person's id gives 404; list and count drop rows whose board or chat is no longer visible; read-all is scoped to own rows.
- Search, My Day, Inbox: membership in the query/guard, private-board rule in SQL, other users' Inbox excluded, archived workspaces excluded. Triage: card must be in MY Inbox, target lane same workspace, `boardAccess.canWrite`, not archived.
- Emails: none selected anywhere; people are `{id, name}`. No password/token exposure.
- SQL: only Prisma API and tagged `$queryRaw` with bound params; `likeEscape` on ILIKE input.
- Validators: all inputs typed and bounded (body 4000, ids lists, client id regex, query lengths).
- Rate limits: send 20/min and 300/h, DM/group creation 30/h, search 90/min (soft limit, fails open by design), channels capped at 50, reactions 20 kinds per message, cards per message 10.

## Found and fixed
1. `isEmoji` accepted strings made only of ZWJ, variation selector or skin-tone modifier (invisible "reactions" that clutter a message and bypass the "choose an emoji" validation). Now requires at least one `Extended_Pictographic` char. Fixed in `chat.ts`. Test: `tests/integration/review3-chat.test.ts`.

## Left open (low, not fixed)
- `/chat/pulse` still reports `workspaceId`, `lastSeq`, unread for a board chat after the user lost board access (counts only, no content; the conversation itself is 404).
- `GET /boards/:id/conversation` creates the conversation row and joins even in a read-only workspace (idempotent bookkeeping, no user content).
- No per-user rate limit on edit, reactions, mute, members/search, my-day (all bounded by caps or own rows).
- Send limit is off by one (21 messages/min pass).
- `/messages/:id/card` into the caller's own Inbox bypasses the 500-card Inbox cap (still capped by lane cap).
- Validators run before auth, so a signed-out call with bad input gets 422 not 401 (matches the documented order; no data leak).

## Performance
Typical request: 2 to 4 round trips (access: conversation + membership [+ board]; then one list query; reactions in one grouped query). Send: replay check, 2 parallel rate reads, parent/mentions in parallel, one transaction. No N+1, all lists bounded and keyset paged.
