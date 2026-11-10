# Security review 5: chat, notifications, markdown (authorization first)

Scope: `routes/chat.ts`, `chat-extras.ts`, `notifications.ts`, `server/notifications.ts`, `lib/markdown.tsx`, `src/app/chat`, `src/app/notifications`. Earlier fixed items (review-security-4-chat, review-privacy) skipped.

## Authorization
All routes: validator, withViewer, requireAuth, withDb, then conversation / workspace / board access. Object level, 404 for hidden objects, emails never selected, SQL only tagged and bound. Notifications: `user_id` in every query, visibility SQL drops rows whose board or chat is no longer visible. No new gaps in these.

## Found and fixed
1. Medium-low, object level: `POST /conversations/:id/messages` and `PATCH /messages/:id` kept any `cardIds` of the workspace (`cardsInWorkspace` checked only `workspaceId`). A member could link a card of a private board they have no seat on, or another person's Inbox card, and the echoed `cardIds` confirmed the id exists (existence oracle; chips for others resolve per viewer). Now the card's board must pass the same rule as `/cards/refs` and search (`linkableBoardWhere`: not another's Inbox; private board only with owner/admin role or a seat). Fixed in `chat.ts`. Test: `tests/chat-card-link-visibility.test.ts`.

## Checked, no finding
- Markdown: React elements only, no `dangerouslySetInnerHTML`; hrefs only via `safeUrl` (http, https, mailto, no credentials), `rel="noopener noreferrer"`, bidi/zero-width stripped, scan budget bounds work. Chat body uses `segments()` with the same `safeUrl`. Card chips link to in-app routes by numeric id.
- Notification list/count/read-all cannot touch another user's rows; read-all `workspaceId` is only an extra filter on own rows.
- Card-from-message: conversation access, lane in same workspace, `boardAccess.canWrite`; private board chat names are not copied to another board.

## Left open (low, already known)
- `/chat/pulse` counts after losing board access; board conversation row created on read in a read-only workspace; link label can differ from its href (plain Markdown behaviour).
