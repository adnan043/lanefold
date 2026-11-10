# Lanefold architecture (for an engineer joining)

Read `AGENTS.md` first: it holds the rules (guards order, forms, security, never edit `src/platform/**`). This file is the map; it does not repeat those rules. Product scope: `SPEC.md`, later decisions: `HANDOFF.md`, state of the build: `STATUS.md`, operations: `RUNBOOK.md`.

## 1. The picture

One Astro project (`output: 'server'`) on ONE Cloudflare Worker. Hono (`src/server/app.ts`, base path `/site-api`) is the only backend; Astro pages call it in-process (`src/server/backend.ts`, `app.request`), the browser calls it with `siteFetch`. Data lives in a Postgres Site Database through Prisma (`prisma/schema.prisma`; raw SQL only as tagged `$queryRaw`). `src/platform/` is the managed core (config, auth, guards, payments, files, cache, background): replaced by `npm run platform -- upgrade`, never edited. The product is a single React SPA at `/app/*` hosted by one page, `src/pages/app/[...path].astro` (`client:only="react"`, `AppRoot`). The template's website, `/account/*` and `/dashboard/*` (owner and billing admin screens) exist beside it; the template's `/jobs/*` job board is removed.

## 2. Request flow

```
browser
  -> /app/*  (Astro host page, prerender=false, pageContext() only decides "sign in" vs "open")
  -> AppRoot (TanStack Query + Router, basepath /app)           src/app/AppRoot.tsx, routes.tsx
  -> call()/siteFetch  src/app/api.ts -> `siteFetch('/site-api' + path)`  (CSRF header, one session refresh)
  -> Hono app.ts middleware, in order:
       previewCookies -> sameOrigin -> /checkout (own formCsrf) -> csrf
       -> bodyLimit 64 KB -> syncPermissions(CATALOGUE)
  -> route chain:  validator -> withViewer -> requireAuth -> [requirePermission(site)] -> withDb
       -> [requireWorkspaceRole(min) | boardFor()/laneFor()/cardFor() | requireConversation(need)]
  -> handler: Prisma queries (workspace_id in every where) or $queryRaw; $transaction for writes
  -> JSON {error, message, fields?} on refusal; success bodies via explicit select/shape functions
Astro pages (website, checkout):  backend(Astro.request) -> same Hono app, in process, cookie forwarded
```

`/me` returns `abilities` (UI hints only; every route re-checks). `Cache-Control: private, no-store` is set per route group (`noStore` middleware).

## 3. Access model (read this before touching any route)

- **Workspace roles** `viewer < member < admin < owner` (`ROLE_RANK`, `src/server/workspaces.ts`). `requireWorkspaceRole(min, param='id')`: not a member or no such workspace -> **404**; member below `min` -> **403**.
- **Board access** `boardAccess()` is ONE query with the visitor's workspace membership inside the `where`. Workspace owner/admin are always board admins; a `board_members` row overrides the workspace role (admin/member/viewer); `private` boards are visible only to board members and workspace owner/admins; another user's Inbox board (`boards.inbox_of`) is never visible. Returns `rev` too, so the poll is one round trip.
- **404 vs 403 rule.** A resource the visitor cannot see answers 404 (same body as a missing one, no oracle). A resource they CAN see but may not do something to answers 403 (or 409 for archived board / read-only workspace). Helpers (`boardFor`, `laneFor`, `cardFor` in `routes/boards.ts`) fetch the row with membership in the `where` (404), then call `boardFor` whose 403/409 refusals are returned as they are and never collapsed into 404 ("the visitor can already see this board"). Do not "simplify" a 403 into a 404 for someone who can see the thing, and never turn a 404 into a 403.
- **Site permissions** (not workspace roles): `CATALOGUE` in `src/server/permissions.ts` (`site:billing:manage`, `site:plans:manage`, `site:workspace:read`, `site:maintenance:manage`) via `requirePermission`. Never reuse or rename a shipped codename.
- Ids in URLs only SELECT. `workspace_id` is in every `where` of every write; the migration comment says every workspace-owned table has it first in its indexes.
- **Write invariant (boards, lanes, cards, labels, checklists, comments, attachments, moves):** inside one `$transaction`, `bumpRev(tx, boardId, workspaceId)` (`UPDATE boards SET rev = rev + 1 ... RETURNING rev`, row-locking, so concurrent writers each get their own rev), stamp `updated_rev` on every row changed, and insert an `activity` row (`kind` is a stable code like `card.moved`, the UI localizes it). Archive instead of delete so the delta sees it. Read the `bumpRev` callers in `boards.ts` before adding a write; a transaction that returns without changing anything must throw (see `StaleMove`, `LaneFull`) so the rev bump rolls back.
- **Positions** are `fractional-indexing` keys computed on the SERVER from a neighbour id (`keyAfter` in `boards.ts`); the client never sends a key. Columns are `VARCHAR(64) COLLATE "C"` (migration `20261102120928_lanefold_mvp`), so every ordering and keyset comparison in raw SQL must say `position COLLATE "C"` and tie-break on `id` (`cardsAfter`, `(position, id) > (...)`). A stale `afterId` is a 409 the client answers by reloading. Safety caps: `MAX_CARDS_PER_LANE` 500 (`entitlements.ts`), `MAX_LANES` 50, 20 cards per add.
- Chat: `requireConversation('read'|'write'|'moderate')` (`routes/chat.ts`); workspace membership is in the query; `Message` rows carry `workspace_id` + `conversation_id`; people are returned as `{id, name}`, never emails (the one exception: `maskEmail`, admins only, `routes/members.ts`).

## 4. Route map (`src/server/routes/`, all mounted at `/` in `app.ts` except as noted)

| File | Prefix / routes | Guards | Notes |
| --- | --- | --- | --- |
| `boards.ts` | `/workspaces` (list, create), `/workspaces/:id/boards`, `/boards/:id` (+ `/rev`, `/changes`, `/star`, `/lanes`), `/lanes/:id` (+ `/move`, `/archive`, `/cards`), `/cards/:id` (+ `/move`, `/archive`, `/restore`) | `withViewer, requireAuth, withDb, noStore`; then `boardFor/laneFor/cardFor` (`read`/`write`/`admin`); board create needs workspace rank 2 | The board-open answer is capped (15 cards per lane, 150 total). `GET /boards/:id/rev` is the poll; `/changes?since=` is the delta (cap 300, `truncated` flag). Creator of a private board gets a `board_members` admin row. 10 own workspaces, 20 boards/hour/workspace. |
| `board-extras.ts` | archived boards/cards/lanes lists, `POST /lanes/:id/restore`, `POST /boards/:id/duplicate` | same, via `boardFor/laneFor` | Cursor lists. Duplicate creates a board with `rev: 1n`. |
| `card-detail.ts` | `/cards/:id/detail`, `/details`, `/activity`, `/people`, labels, card members, checklists + items, comments, attachments (`link`, `upload`, `/attachments/:id/complete|view`), `/cards/:id/cover` | same, via card/board access; writes bump rev + activity | Uploads: `createUpload`/`completeUpload` (platform `files.md`), bytes never pass the Worker. Storage tracked in `workspaces.storage_used_bytes`. |
| `chat.ts` | `/chat/pulse`, `/workspaces/:id/conversations`, `/boards/:id/conversation`, `/conversations/:id/messages|read|mute`, `/messages/:id` (+ reactions, pin) | `requireWorkspaceRole('viewer')` on workspace routes, `requireConversation(need)` on conversation routes | Read-only workspaces answer 409 `workspace_read_only` on writes. Send is rate limited (20/min, 300/h) and idempotent by `client_id`. |
| `chat-extras.ts` | `/conversations/:id`, `/workspaces/:id/members/search`, `/cards/refs`, `POST /messages/:id/card` | as above | Card-from-message runs the same rev bump + activity transaction as a board write. |
| `members.ts` | `/workspaces/:id/members`, role change, remove, `/leave`, `/join-links`, `/invites`, `POST /invites/accept` | `requireWorkspaceRole('viewer')` for list/leave, `'admin'` for the rest | Admin lists carry masked emails only. Invites may also be emailed (section 7b): `POST /workspaces/:id/invites` takes `email` and `sendEmail`, and `POST /workspaces/:id/invites/:inviteId/email` resends a failed one (limits 30 per workspace and 10 per inviter per hour, 5 sends per invite). |
| `workspace-settings.ts` | `PATCH /workspaces/:id` (admin), `POST /workspaces/:id/transfer` (owner), `POST /workspaces/:id/archive` (owner, typed name), `POST /workspaces/:id/restore`, `GET /workspaces/archived`, `/preferences` | `requireWorkspaceRole(...)`; preferences self-only; restore checks the owner row in its own query | An archived workspace is closed to everyone; nothing is hard-deleted. |
| `account-preflight.ts` | `GET /account/delete-preflight` | `withViewer, requireAuth, withDb`; own id only | What blocks deleting the signed-in account (`last_workspace_owner`, `paid_workspace`, `workspace_needs_action`) and a capped summary of what goes or stays anonymous. Mirrors the database trigger's conditions; the managed `POST /auth/delete-account` flow is unchanged. Shown at `/app/settings/account`. |
| `import-export.ts` | `POST /workspaces/:id/import/trello/dry-run` and `/start`, `POST /boards/:id/import/trello/cards`, `GET /boards/:id/export.json` and `export.csv` | `membership()` / `boardAccess()` in the query; export needs board admin | The browser parses the Trello file and sends chunks of at most 40 cards (48 KB); idempotent per import id; no new table. |
| `saved-filters.ts` | `/boards/:id/saved-filters`, `PATCH` and `DELETE /saved-filters/:id` | board access in the query | A screen exists in `src/app/boards/saved-filters.tsx`. |
| `notifications.ts` | `/notifications`, `/unread-count`, `/read-all`, `/:id/read` | own rows (`user_id` in where) | Filtered by workspace membership, not by board (see sharp edges). |
| `search.ts` | `/workspaces/:id/search`, `/my-day`, `/workspaces/:id/inbox`, `/inbox/cards`, `/inbox/cards/:id/triage` | access in the query | Search is bounded `ILIKE`, helped by guarded trigram GIN indexes (`20261103100000_search_trigram`); rate limited per user. |
| `billing.ts` | `/workspaces/:id/billing` (viewer), `.../billing/checkout` (admin), `/billing/mine`, `/billing/settings`, `/billing/plans(/:plan)`, `/billing/workspaces` | workspace role, or `requirePermission(BILLING_MANAGE / PLANS_MANAGE / WORKSPACE_READ)` | Checkout sets `customerRef` (section 6). |
| `checkout.ts` | `/checkout` (own app mounted BEFORE `csrf`, with `formCsrf`, 8 KB body), `/memberships` list and `POST /:id/cancel` | cancel: buyer AND still admin/owner of the membership's workspace, else 404 | Template payment routes. |
| `site.ts` | `/site` brand | template | Not Lanefold product. The template's `jobs.ts` is removed. |

Every route has a row in the authz matrix (section 11).

## 5. Entitlements and plans (`src/server/entitlements.ts`)

- The ONLY place that decides limits. Routes call `getEntitlements(db, workspaceId)` after the membership check; never read `plan_limits`, `app_settings` or `workspaces.plan` directly.
- Cost: one `workspaces LEFT JOIN plan_limits` query in parallel with the cached `app_settings` row (Site Cache key `app:settings`, 1 h TTL, cleared by `invalidateAppSettings()` on save). Memoized per request per Prisma client; call `forgetEntitlements` after a write that changes it.
- Billing mode (`app_settings.billing_mode`): `FREE_FOR_ALL` = every feature, only `SAFETY_CAPS` enforced, never read-only; `PAID` (default) = the workspace's plan limits (`max_members`, `max_file_bytes`, `storage_quota_bytes`, `max_flows`, `audit_log`).
- **Grace and read-only:** over a PAID limit (members or storage) -> `overLimit`; `workspaces.grace_until` is the clock (default `grace_days` 14). Before it passes: `inGrace`, still writable. After: `readOnly: true`, and every write path answers 409 `workspace_read_only` (`boardFor`, chat, members). It heals by itself when back under limits. Nothing is ever deleted by a downgrade.
- `startGraceForOverLimit(db, {plan?, workspaceId?})` is two raw statements: start the clock where over and null; clear it where back under or in FREE_FOR_ALL. Called by the sweeps, `applyWorkspacePlan`, and the settings/plan routes.
- Pure core `computeEntitlements` is unit tested directly. `soft-limit.ts` (per-user counters on the Site Cache) is a cost guard, fail-open and non-atomic, not a security boundary.

## 6. Billing and the payments hook flow

1. `POST /workspaces/:id/billing/checkout` (workspace admin): the price is a KEY read from `plan_limits.price_key_monthly`, never an amount from the browser; refuses non-upgrades. It calls `createCheckout` with `customerRef: "<userId>:<workspaceId>"` (set ONLY there; plain checkout uses `<userId>`). `refParts()` in `payments-hooks.ts` parses it.
2. The platform sends signed events (live) and `/thanks/` confirm calls the same hooks, so hooks can run more than once and must be idempotent. `paymentHooks.onMembershipChanged`:
   - `recordMembership(membership, mode, event.createdAt)` writes the `memberships` row with one conditional `updateMany` (`last_event_at IS NULL OR <= eventAt`); an older event returns `stale: true` and changes nothing. `workspace_id` comes from `customerRef` and is never blanked by an update without one. First insert races are caught on P2002.
   - if not stale, `applyWorkspacePlan`: a price in `plan_limits.price_key_monthly` that `grantsAccess` sets the plan (and `member_limit`); an ended one sets `free` only if the workspace is still on THAT plan and no other membership of the same workspace+price still grants access (same predicate as the sweep). The update is conditional on the plan read; then `startGraceForOverLimit` and an `audit` row `workspace.plan_changed`.
3. `onCheckoutPaid/Failed` -> `recordOrder` (unique `checkout_id`, never moves refunded back to paid); `onRefund` updates the order.
4. Cancel (`checkout.ts`) calls the platform, `recordMembership` (no event time, so "now"), then `applyWorkspacePlan`.
5. Sandbox prices `pro-monthly`, `team-monthly` must exist (`owner-actions.md`).

## 7. Background jobs (`background.json`, handlers `src/server/jobs/`, wiring `src/server/background.ts`)

Four scheduled lists (UTC, retries 3, concurrency 1, keyset paged and bounded: `MAX_PAGES`, `DELETE_BATCH` in `jobs/logic.ts`, safe to repeat) plus the unscheduled `invite-emails` list:

| Job | At | What |
| --- | --- | --- |
| `plan-sweep` | 04:00 | `sweepEndedMemberships`: workspaces whose paid membership (matched by `memberships.workspace_id` + the plan's price key) no longer grants access go back to `free`, grace started, audited with `by: 'sweep'`. Rows with NULL `workspace_id` never downgrade anything. |
| `grace-sweep` | 04:20 | `sweepGrace`: start the grace clock for newly over-limit PAID workspaces, drop it for those back under or in FREE_FOR_ALL. |
| `old-data-cleanup` | 04:40 | `cleanupOld`: deletes invites and join links older than `inviteDays` (30), read notifications older than `notificationDays` (90), and abandoned uploads, in bounded batches. |
| `file-cleanup` | hourly | `cleanupDeletedFiles` (`jobs/files.ts`): deletes the stored bytes listed in the `file_deletions` outbox (filled by database triggers); a missing file counts as done, transient errors retry, a file is given up after 20 failed attempts. |
| `invite-emails` | on demand | `runInviteEmails` (`jobs/invite-email.ts`), retries 4, concurrency 2. See 7b. |

Check with `npm run platform -- jobs`.

## 7b. Invite emails (Phase 11, `src/server/mail/`, `jobs/invite-email.ts`)

- Flow: the invite route creates the `workspace_invites` row with `email_status = 'queued'`, seals `{address, raw token}` with the site secret (`sealInviteItem`, AES-GCM via `platform/auth/two-factor.ts`, bound to the inviter), and sends ONE job (at most `MAX_BATCH` = 5 invites) to `invite-emails` with a key `invite-email-<id>-<n>`. The payload shown in the Jobs tab holds nothing readable. The address is never stored in our tables (the row keeps only a keyed HMAC `email_hash` to bind the invite) and never logged.
- Handler: skips rows already `sent`, used, expired or in an archived workspace; skips a stale job whose token was rotated by a resend; sends through `sendMail` (`mail/send.ts`: fixed Resend-compatible endpoint, 8 s timeout, `Idempotency-Key`, header-injection checks, never throws). Results: `sent`; `retry` (5xx, 429, timeout) throws so the platform retries; `failed` (4xx) marks the row at once; missing owner secrets `RESEND_API_KEY` or `MAIL_FROM` mark `not_configured`. A run stops after 40 s and leaves the rest to a retry.
- Row state (migration `20261103160000_invite_email_status`): `email_status` (`queued`, `sent`, `failed`, `not_configured`, NULL), `email_queued_at`, `email_sent_at`, `email_attempts`, plus indexes on `(workspace_id, email_queued_at)` and `(created_by, email_queued_at)` that serve the hourly limits.
- Without the secrets, or in the editor Preview, the create and resend responses carry an `emailPreview` (subject and body) for the inviter only. Client: `members/invite-modal.tsx`, `members/resend-email-modal.tsx`. Templates in 20 languages: `mail/templates.ts` (the 19 non-English ones are drafts).

## 8. Client (`src/app/`)

- `AppRoot.tsx`: QueryClient defaults (`staleTime` 30 s, one retry only for non-4xx), `I18nProvider`, router. `routes.tsx`: literal paths under `/app`: `/`, `/boards`, `/b/$boardId` with child `/c/$cardId` (card modal over its board), `/my-day`, `/inbox`, `/chat`, `/members`, `/join/$token`, `/onboarding`, `/settings` (redirects to `/settings/appearance`) with `appearance`, `language`, `workspace`, `billing`, `import-export` and `account`. Screens are lazy route components; `staticData.title` is a message KEY. `shell.tsx` is the chrome (nav, workspace switcher, top bar, bell, chat unread badge, palette and shortcuts hosts). `workspace.tsx` = current workspace context.
- Folders by feature: `boards/` (board screen, canvas, lane, card, composers, archive, settings, move dialog), `cards/` (card modal, checklists, comments, attachments, description markdown), `chat/` (feed hook, conversation view, composer, mentions, announce), `members/` (including the invite and resend-email modals), `import-export/` (export menu), `settings/` (appearance, language, billing, workspace, import-export, account, prefs), `palette/` (Cmd+K), `notifications/` (bell + panel), `inbox/`, `my-day/`.
- **Card modal** (`cards/card-panel.tsx`, `cards.css`): a native `<dialog>` opened with `showModal()` and rendered by the board screen's `<Outlet />` (route stays `/b/$boardId/c/$cardId`, `staticData.keepFocus` so the shell leaves focus alone). The dialog is a transparent full-viewport frame, `.cd-panel` the box (min(56rem, 100vw - 2rem), max 90dvh, body scrolls inside; two columns, one at <= 720px; full-screen sheet at <= 560px). Scrim click closes only when the pointerdown also started on the scrim; Esc is claimed in the dialog's keydown (menus, pickers and fields with their own Esc handle it first and call `preventDefault`); `html.cd-locked` stops background scroll; focus returns to the opener on unmount. No transform on the dialog or box (fixed popovers inside would position against it). **Layers inside the modal:** the top layer hides and inerts anything in the body, so floating layers render INTO the top-most open modal dialog: `src/portal/ui/portal-host.ts` (`useOverlayHost()`, `portalHost(el)`, pure `nextDialogStack`/`pickHost`, a MutationObserver on `dialog[open]`) is used by `ToastProvider`, the board's `UndoBar` and `FailureBar` and `Menu`; `Popover`/`DatePicker`/`ColorPicker` are rendered inline (position fixed, so already inside the dialog); the image lightbox and `useConfirm` are native dialogs that stack above. Shortcuts and the palette ignore keys while any `dialog[open]` exists.
- **`api.ts`**: `call(method, path, body)` over `siteFetch`, throws `ApiError{status, code, fields}`. All server types are mirrored there.
- **Query keys** are arrays, workspace/board id last, one root per feature: `['workspaces']`, `['boards', workspaceId]`, `['board', boardId]`, `['card', cardId]`, `['chat', 'conversations', workspaceId]`, `['chat','pulse']`, `['notifications','count']`, `['members', workspaceId]`, `['inbox', workspaceId]`, `['my-day', today]`, `['billing','app', id]`. Invalidate by root (`['boards']`, `['chat']`). Per-feature `queries.ts` files hold the `queryOptions`.
- **Polling and who owns each timer** (one owner each, all pause on a hidden tab):
  - Board: `use-board-sync.ts` `useBoardSync` only. `GET /boards/:id/rev` every 5 s + up to 1 s jitter, exponential back-off to 60 s on errors, delta fetch only when rev moved, skipped while any own write is `tracked()` in flight, 404 stops it and reloads. Visibility/focus wakes it. Every write must go through `tracked()` or a poll can overwrite it.
  - Chat pulse: `chat/api.ts` `usePulse(fast)`: `GET /chat/pulse` about 3 s with a chat open and the person active, 12 s idle (60 s without input), 30 s otherwise and on errors. Open conversation: `use-message-feed.ts` polls with `after=<seq>` and `useVisibleInterval` refreshes the newest window every 20 s.
  - Notification bell: `refetchInterval` 30 s on `['notifications','count']` in `bell.tsx`.
- **Optimistic updates** live as pure functions in `board-state.ts` (`moveCardInLanes`, `moveLaneInList`, `patchCard`, `insertCard`, `removeCard`, `applyChanges` for deltas, and the rollbacks `revertCardMove`, `revertLaneMove`) returning NEW state; position keys come from `keyBetween` (fractional-indexing, null when neighbours are out of order, so the old key stays). The server's key and rev replace the guess on success; on error revert and invalidate `['board', id]`. 409 `stale` means reload.
- **`lazy.ts`**: `createLoader` / `lazyWithRetry(importer)` for widgets that must never take the shell down (palette, notification panel): retry once after 400 ms, a failure is not cached, renders nothing. Use it instead of `React.lazy` for non-route widgets.
- **UI kit**: `src/portal/ui/` is shared with the dashboard. Import everyday pieces from the barrel `'../portal/ui'` (Button, Card, Field, Modal, Drawer, Menu, toasts...). The barrel DELIBERATELY excludes the heavy parts; import them from their file: `ui/popover` (Popover, DatePicker, ColorPicker), `ui/chips` (Chip, ChipInput, AvatarStack, ColorDot), `ui/command` (CommandPalette), `ui/date`, `ui/contrast`, `ui/fuzzy`. Adding them to the barrel puts about 14 KB in the chunk every screen loads.

## 9. i18n and CSS

**i18n** (`src/i18n/`): 20 locales in `locales.ts` (en default; ar, fa, ur are RTL), one catalog `messages/<code>.json` each. `tests/i18n.test.ts` enforces: a file per locale and no strays, exactly the keys of `en` (plural forms by CLDR suffix), same placeholders, no empty strings. `NEEDS_REVIEW` (`meta.ts`) is every non-English locale (test asserts it): none has had native review yet. Server errors: routes send `{error: 'code', message}`; the client shows `errors.<code>` from the catalog, else the server message (`i18n/errors.ts`). `ERROR_ALIASES` maps extra codes (payment gateway `e_*`, `storage_limit`) to an existing message. `tests/errors-coverage.test.ts` scans `src/server` for literal codes (`problem('x'`, `refuse(403, 'x'`, `code: 'x'`) and fails if one has no `errors.*` entry in all 20 catalogs (deliberate exceptions are in its `INTERNAL` set). A new error code means a new key in all 20 files.

**CSS**: tokens (colour, type, shape, `--accent`, light/dark via `prefers-color-scheme` and `data-theme`) only in `src/styles/global.css`; `src/styles/app.css` (kit classes), `a11y.css`, `forced-colors.css` come with `layouts/App.astro`. Eager for `/app`: `app/app.css`, `app/responsive.css`, `app/tables.css` (imported by the host page). Lazy, imported by the component that needs them so they land in that screen's chunk: `cards/cards.css`, `cards/a11y.css`, `cards/markdown.css`, `chat/chat.css`, `notifications/bell.css`, `members/members.css`, `boards/polish.css`, `boards/a11y.css`, `boards/settings.css`, `settings/settings.css` + `accents.css` (via `settings/prefs.ts`), `phase3.css` (my-day, inbox). **Convention in `responsive.css`:** every override is prefixed with `:root` (one extra specificity step) so it wins over the lazy sheets whatever order the bundler loads them; logical properties only (RTL), no hex, no inline `style` (dnd-kit transforms are the known exception). Follow the z-index order comment at the top of that file.

## 10. Data model summary (`prisma/schema.prisma`, 19 migrations: 7 template, 12 Lanefold)

- Managed by the platform: `users`, `roles`, `permissions`, auth tables, `audit_events`, `job_deliveries`, `payment_events`, `orders`, `memberships`. Do not change the managed ones. (The template's `jobs` table is dropped.)
- Lanefold: `user_profiles`; `workspaces` (+ `workspace_members`, `workspace_invites`, `workspace_join_links`, `workspace_removals`); `boards` (+ `board_members`, `board_stars`), `lanes`, `cards`, `card_members`, `card_watchers`, `labels`, `card_labels`, `checklists`, `checklist_items`, `comments`, `comment_mentions`, `attachments`, `card_links`, `activity`, `notifications`, `saved_filters`; chat `conversations`, `conversation_members`, `messages`, `message_reactions|mentions|card_refs`; settings `app_settings` (one row, id 1), `plan_limits`; cleanup outbox `file_deletions`.
- Foreign keys to `users` were added by `20261103130000_account_deletion_cleanup` (25 of them, with triggers): authored content keeps its row with the author NULL, personal rows cascade, and the platform's `DELETE FROM users` is refused by trigger for the three blocker reasons in `routes/account-preflight.ts`. Workspace-owned tables carry `workspace_id` first in their indexes.
- **Three non-obvious pieces:**
  1. **`boards.rev` + `updated_rev`**: `boards.rev` is a per-board counter bumped inside every write transaction; `lanes`, `cards` (and children) carry `updated_rev`. The poll compares revs, `/changes?since=N` returns rows with `updated_rev > N`. It is the whole sync protocol; there is no event stream.
  2. **`memberships` (`workspace_id`, `last_event_at`)**: the platform's subscription copy, extended so a subscription belongs to a workspace and out-of-order payment events are ignored (section 6). The daily sweep matches by `workspace_id`.
  3. **`conversations` / `messages`**: `conversations.last_seq` and `messages.seq` give gap-free per-conversation ordering (unique `(conversation_id, seq)`); `messages.client_id` unique per conversation makes a retried send idempotent; a DM is one row via `dm_key = "<smaller id>:<larger id>"` (unique with `workspace_id`); board chat is a conversation with `board_id`. Also denormalized counters (`workspaces.member_count`, `storage_used_bytes`, `lanes.card_count`, card checklist/comment/attachment counts) are kept by the writes that change them.

## 11. Testing

- **Unit** (`tests/*.test.ts`, no database): pure logic (`board-state`, `entitlements` via `computeEntitlements`, `payments-hooks` parts, `members-rules`, i18n parity, errors coverage, contrast, markdown, lazy, jwt/password...). Run `npm test` (does `prisma generate && vitest run`).
- **Integration** (`tests/integration/*.test.ts`): real Postgres, skipped unless `TEST_DATABASE_URL` is set (use the throwaway `lanefold_test` database, NEVER `lanefold`; the harness empties tables). They import the Hono `app` and call it through `support/harness.ts` (`Browser`, `signedIn`, `resetDatabase`). `vitest.config.ts` sets `fileParallelism: false` because the files share one database; 30 s timeout. Tests run against the Node Prisma build (`src/generated/prisma-node`), not the workerd one.
- **Authz matrix** (`tests/integration/authz-matrix.test.ts`): two workspaces (A: owner, admin, member, viewer, member-not-on-private-board; B: another owner), a private board, and a TABLE with one row per route (method + path as `app.routes` lists it, who may call, what others get). Checks signed-out 401, other workspace 404, below-minimum role 403, private board 404, site-permission 403, no email or `passwordHash` in any body, and workspace B ids in workspace A routes. The **meta-test** compares `app.routes` (non-`ALL`) with the TABLE both ways and FAILS when a route is not listed or a row has no route. The meta-test itself needs no database; the rest does.

### Checklist: adding a route correctly
1. Validator first (`hono/validator`, `idOf`, `textField`... from `src/server/validation.ts`; 422 with `fields`).
2. Guards in order: `withViewer, requireAuth, [requirePermission], withDb, then requireWorkspaceRole / boardFor / laneFor / cardFor / requireConversation`; `noStore` for private reads.
3. Workspace membership and `workspace_id` inside the `where`; unseen resource -> 404; seen but not allowed -> 403 (never swap them); archived -> 409; read-only workspace -> 409 on writes (`getEntitlements`).
4. Explicit `select` / shape function; never return emails or hashes.
5. Board-scoped write: one `$transaction` with `bumpRev`, `updated_rev` on touched rows, an `activity` row, counters updated; throw inside the transaction to roll back a no-op.
6. Ordering keys server-side with `keyAfter`; `COLLATE "C"` in raw SQL.
7. Keyset pages, bounded `take`, no N+1; rate limit anything costly (`soft-limit.ts` or the DB-backed limits already used in chat).
8. Every new `problem('code', ...)` gets `errors.code` in all 20 catalogs.
9. `.route()` in `app.ts` (chained so `AppType` stays typed), add the row to the authz matrix TABLE, add a route test (another user gets 404).
10. New client reads: `queryOptions` with the key convention above; writes: `tracked()` for board writes, optimistic helper + rollback.
11. Then `AGENTS.md`'s `review.md` pass.

## 12. Known sharp edges (still open, checked in code on the date of writing)

From `docs/product/review-*.md`, `STATUS.md` and `owner-actions.md`. Findings those documents list that the code already fixes (private-board creator, chat in read-only workspaces, stale-move rev bump, cancel by a removed admin, lane-page cursor bound, `/jobs/` noindex) are not repeated.
- **Search is `ILIKE`** (`routes/search.ts`): the trigram GIN indexes are created by a guarded migration and exist only if the database allowed `pg_trgm`; without them a rare term in a very large workspace reads many rows (`review-query-plans.md` #12). My Day for a user with tens of thousands of assignments is slow (#16).
- **Masked emails keep the domain** (`maskEmail`, `m•••@domain`): the domain can leak a company; decision pending (`owner-actions.md`, `review-privacy.md`).
- **Viewer board override**: a `board_members` override currently beats a workspace `viewer` (`resolveBoardRole`); decision pending.
- **Notifications are filtered by workspace, not by board**: after losing access to a board, old notifications still carry its ids (`review-security.md`).
- **Account deletion** is blocked in three cases (see the preflight route) until the person fixes them; a workspace can be archived and restored but never hard-deleted (`delete-account-design.md`).
- **Soft rate limits** (`soft-limit.ts`) are fail-open and can undercount in a burst; they are cost guards only.
- **Polling cost**: a user with a board and chat open is about 40-45 queries/minute (`review-performance.md`); a push channel would replace only `use-board-sync.ts`.
- **Typecheck**: `npm run typecheck` exists (`typescript` is a devDependency) but a clean result is not recorded; `npm run build` and tests are the checks. Browser verification of `/app` (drag, touch, RTL, uploads) is not recorded; uploads need the platform Storage pack.
- **i18n**: 19 non-English catalogs are machine-assisted and unreviewed (`NEEDS_REVIEW`).
- Older client findings (`review-correctness-client*.md`: chat `known` seq after own send, drawer drafts across cards) were not re-verified here; re-check before relying on them.
