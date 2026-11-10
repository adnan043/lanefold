# Duplicate-submit (idempotency) review

Scope: every create-style POST in `src/server/routes/*` plus the client mutations that call them. Read-only audit; no code changed (boards.ts and chat.ts belong to other agents, and no protection below is possible without a migration, see "Migration needed").

Legend: KEY = idempotent by client key and unique index. NATURAL = a unique constraint, lock or upsert makes a replay harmless. DUP = a replay creates a second row.

## Client facts (apply to every row)

- `QueryClient` default is `mutations: {retry: false}` (`src/app/AppRoot.tsx:40`). No automatic replay of any write. So a replay only comes from: double click/Enter, the user pressing Retry after a lost response, or a service-worker/offline replay (none exists in the app).
- Buttons are `pending` + disabled during the request in: new board modal (`board-list.tsx`, modal not dismissible while pending), invite modal, comment composer (`busy === 'new'`), checklist add/new (`busy`), billing checkout, workspace create (`useMutation`), saved filter create, import. Double click inside one tick is blocked by the disabled button after the first render.
- Not protected by a disabled button: board lane/card quick-add (`boards/actions.ts` `addCards`, `addLane`). They are optimistic fire-and-forget with a negative temp id; the composer clears at once, so Enter twice with the same text sends two requests only if the user retypes. The failure path offers Retry: `rollback(... () => addCards(laneId, titles))` and `addLane(name)` re-POST after a LOST response (network error / 5xx where the server may have committed). That is the real duplicate vector.
- Chat send keeps the same `clientId` on Retry (`use-message-feed.ts`), import keeps `importId`. Onboarding has a hand-rolled "lost first response" lookup by workspace name (heuristic, see row).
- Attachment upload is a 3-step flow (create row, PUT bytes, complete). Complete is idempotent server side.

## Route table

| Route | Class | What a replay does |
| --- | --- | --- |
| `POST /conversations/:id/messages` (chat send) | KEY | `unique(conversationId, clientId)`; replay returns the stored message (200). Other sender with same key: 409. |
| `POST /workspaces/:id/import/trello/start` | KEY | Per `importId` via audit-event record + advisory lock; replay returns same board (`resumed`). |
| `POST /boards/:id/import/trello/cards` (chunk) | KEY | `unique(boardId, importId, externalId)` + pre-check; replay = `skipped`. |
| `POST /workspaces/:id/conversations` (channel/DM/group) | NATURAL for DM and `#general` | DM: `unique(workspaceId, dmKey)` plus P2002 fallback returns the existing one. `#general`: advisory lock. Board chat: unique `boardId`. |
| `POST /workspaces/:id/conversations` (non-general channel) | DUP | Same name allowed twice (no unique on name); bounded by MAX_CHANNELS. Group (3+ people) also DUP. |
| `POST /attachments/:id/complete` | NATURAL | `updateMany where ready=false`; second confirm answers ok, counters not double-bumped. |
| `POST /invites/accept` | NATURAL | `unique(workspace, user)` P2002 returns `alreadyMember: true`; seat taken once. |
| `POST /workspaces/:id/leave`, `/archive`, `/restore`, `/transfer`, lane/card `archive`/`restore`/`move`, `/inbox/cards/:id/triage`, `/conversations/:id/read`, `/notifications/*read*` | NATURAL (state transitions, not creates) | Second call is a no-op or a 404/409, no new row. Not audited further. |
| `POST /workspaces` | DUP | Lock only protects the 10-workspace cap; a replay creates a second workspace of the same name (new slug) plus its `#general`. Client works around it only in onboarding. |
| `POST /workspaces/:id/boards` | DUP | Second board with same name and its lanes. Bounded by BOARDS_PER_HOUR. (boards.ts, not edited.) |
| `POST /boards/:id/duplicate` | DUP | Second copy "(copy)". Bounded by BOARDS_PER_HOUR. |
| `POST /boards/:id/lanes` | DUP | Second lane with the same name. Bounded by MAX_LANES. (boards.ts) |
| `POST /lanes/:id/cards` | DUP | Titles inserted again at end of lane. Bounded by per-lane cap. Highest-frequency create. (boards.ts) |
| `POST /workspaces/:id/inbox/cards` (quick capture) | DUP | Duplicate card. The Inbox board itself is NATURAL (advisory lock). Cap INBOX_CAP. |
| `POST /messages/:id/card` (card from message) | DUP | Second card from the same message, bounded by MAX_CARD_REFS (10) per message. |
| `POST /cards/:id/comments` | DUP | Second identical comment, second notifications, `commentCount` +1 again. Rate limit commentsPerMinute only. |
| `POST /cards/:id/checklists` | DUP | Second checklist with same title; cap checklistsPerCard. |
| `POST /checklists/:id/items` | DUP | Items appended again; cap itemsPerChecklist; `checklistTotal` incremented again (counter stays consistent with rows). |
| `POST /boards/:id/labels` | DUP | Second label with same name and colour; cap labelsPerBoard. |
| `POST /cards/:id/attachments/link` | DUP | Second identical link attachment; cap attachmentsPerCard. |
| `POST /cards/:id/attachments/upload` | DUP (harmless) | Second unfinished row + a second platform upload grant. Never counted until `complete`; `unfinishedUploads` cap; unfinished rows are swept via the file outbox. |
| `POST /boards/:id/saved-filters` | DUP | Same name twice (advisory lock only protects the cap). Cap MAX_PER_BOARD. |
| `POST /workspaces/:id/invites` | DUP | Second invite token; if `sendEmail`, second email (job key `invite-email-<inviteId>-0` is per NEW invite, so it does not dedupe). Cap CREATE_PER_HOUR (soft, read-then-write). Most user-visible (duplicate email to a third party). |
| `POST /workspaces/:id/invites/:id/email` (resend) | Bounded | EMAIL_ATTEMPTS_MAX per invite; each call may send. Replay = one extra email, bounded. |
| `POST /workspaces/:id/join-links` | DUP | Second link. Harmless; soft cap. |
| `POST /workspaces/:id/billing/checkout` | DUP (harmless) | Creates a second platform checkout session; no charge until the buyer pays one. `softLimited` 10 per 10 min. Payment itself is idempotent in `payments-hooks.ts` (unique `Order.checkoutId`, `Membership.subscriptionId`, P2002 handled). |
| `POST /checkout` (public) | DUP (harmless) | Same as above. |
| `POST /checkout/:id/cancel` | NATURAL | Cancel of an already-cancelled session. |

Side effects on replays worth noting: comments and invites also fire notifications/emails; cards, lanes and labels write an `activity` row each.

## Recommendations, ranked by risk

1. **Invites with email (`POST /workspaces/:id/invites`).** A retry after a lost response sends a second email to an outside person, and burns hourly quota. Needs a key. Cheapest fix without migration is not available (see below). Interim: the modal already disables the button; keep it so, and show the first response's token if a retry is detected is not possible without server memory.
2. **Quick-add cards and lanes (`/lanes/:id/cards`, `/boards/:id/lanes`) via the failure-bar Retry.** Most frequent create, and the only create whose client explicitly re-POSTs after an ambiguous failure (status 0 / 5xx). Retry should only be offered for definite failures (4xx), or the request should carry a key. `retryable()` in `boards/actions.ts:33` currently allows status 0 and 5xx. Client-only mitigation (no server change): on a network/5xx failure, reload the lane/board first and offer Retry only if the titles are not present. boards.ts is owned by another agent: report to them.
3. **Comments (`/cards/:id/comments`).** Visible duplicate for everyone plus duplicate notifications. Client: composer keeps text on failure; make sure a retry after status 0 is a manual resend (it is: no auto retry), but there is no key, so a user who resends after a timeout posts twice.
4. **`POST /workspaces` and `POST /workspaces/:id/boards`.** Duplicates are bulky (a workspace plus `#general`, a board plus lanes) but capped. Onboarding has a name-based lookup heuristic that can wrongly adopt an older same-named workspace only if its id is unknown at the time; acceptable.
5. **Card from message, inbox capture, checklists, items, labels, link attachments, saved filters, channels/groups, board duplicate, join links.** Low impact; bounded by caps and rate limits; user can delete the duplicate.
6. **Checkout and upload grants.** Harmless by design (nothing charged or counted until the second step, and webhook handlers are idempotent).

## Migration needed (not implemented)

Following the chat/import pattern needs a stored key, and none of these tables has one, so every fix needs a migration. Nothing was changed.

- Minimal pattern: nullable `client_id VARCHAR(32)` plus `@@unique([<scope>, createdBy, clientId])` (NULLs do not collide in Postgres, so old rows and clients without a key keep working), the route does `findUnique` replay first and treats P2002 as replay, and the client generates `newClientId()` (already in `src/app/chat/api.ts`) once per user intent and reuses it on Retry.
- Tables in priority order: `workspace_invites` (scope workspaceId), `cards` (scope laneId or boardId; also covers inbox capture and card-from-message), `lanes` (boardId), `comments` (cardId), `workspaces`, `boards`, then checklists, labels, attachments, saved_filters.
- No-migration alternative (what import does): record the key in `audit_events` (`targetType`, `targetId`) under an advisory lock. Works, but adds a write and a lock per create and the unbounded audit table is the wrong home for high-frequency creates; reasonable only for invites (low frequency, already audited as `workspace.invite.created`: store `clientKey` in its `meta`, look it up before creating). Not done here because it needs coordinated client and test changes.
