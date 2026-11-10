# Lanefold: product and build spec

> Save this file in the repo as `docs/product/SPEC.md`.
> For the coding agent: `AGENTS.md` and `docs/agent/*.md` are the law for HOW to build on this template. This file says WHAT to build. If they conflict, AGENTS.md wins: say so in your phase summary instead of working around it. Never edit `src/platform/**` or `docs/agent/**` (managed).

---

## 1. Product

**Lanefold** (working name) is a fast, calm, keyboard-first kanban app with built-in team chat, made for teams of up to about 100 members. It must be good enough that people pick it over Trello for everyday work.

- Never hard-code the name. Read it from the platform brand (`useSite()` in the SPA, `site.name` in pages). Renaming is then a platform setting.
- **Vocabulary (UI text lives in i18n catalogs, so it is changeable):** Workspace → Boards → **Lanes** → Cards. **Flows** = automations. **Add-ons** = integrations. Also **My Day**, **Inbox**, **Chat**. Code and database say `lane`, not `list`.
- **Why people switch from Trello:** generous free tier (unlimited boards), built-in chat (Trello has none), My Day across all boards, Cmd+K palette and shortcuts, custom colors, 20 languages, one-click import from a Trello export, a calm UI without popover-on-popover.

## 2. Where everything lives (routes)

| Address | What | Built as |
|---|---|---|
| `/`, `/about/`, `/blog/…`, templates gallery | marketing, SEO | static Astro pages |
| `/pricing/` | plans from the price catalogue | SSR page; hidden (404) only if billing mode is switched to `FREE_FOR_ALL` |
| `/b/<token>/` | public read-only board share link | SSR page, `noindex`, token is random and stored hashed |
| `/account/*` | sign-in, register, reset | existing, managed. Do not rebuild |
| **`/app/*`** | **the Lanefold product (boards, My Day, Inbox, Chat, settings)** | **ONE new host page `src/pages/app/[...path].astro`, copied from `src/pages/dashboard/[...path].astro`, `client:only="react"`, own TanStack Router with `basepath: '/app'`. Code in `src/app/`. Reuses the UI kit in `src/portal/ui/`** |
| `/dashboard/*` | platform admin for the site owner: users, roles, activity, plus new Billing, Plan limits, Workspaces screens | existing portal + new screens |
| `/site-api/*` | the only backend (Hono) | new `src/server/routes/*.ts`, one `.route()` line each in `src/server/app.ts` |

Why a separate `/app`: AGENTS.md allows "a separate app at its own path only when asked". The owner asked for a product, and a kanban canvas with a bottom dock and chat dock does not fit the admin dashboard shell. Set `afterSignInPath: '/app'` in `src/server/auth-settings.ts` and confirm `registration: 'open'`. The owner's one-click "Open admin" keeps landing on `/dashboard`. Add a short "Product" section to AGENTS.md pointing here.

## 3. Stack decisions (read before writing code)

| Idea from earlier plans | On this template |
|---|---|
| TanStack Start, server functions | **Astro 7 + `@astrojs/cloudflare`**, React 19 only inside the SPAs. Hono is the only backend. Never add another framework |
| Tailwind 4, shadcn/ui, radix, cva, clsx, tailwind-merge, lucide-react, sonner, React Hook Form, Zod | **None of these.** Template rule: never a second UI kit, icon pack or CSS framework. Use plain CSS tokens (`src/styles/`), the kit in `src/portal/ui/` (Button, Card, Drawer, Modal, Menu, Tabs, Select, Switch, Toast, `useConfirm`, `useForm`, `Icon`), hand-written `hono/validator` validators and `src/lib/rules.ts` |
| Missing UI pieces (command palette, popover, color picker, date picker, chips, avatar stack) | **Add them to the kit** (`src/portal/ui/`, export from `ui/index.ts`, show on `/dashboard/components`), built from tokens, `<dialog>` and CSS. Icons: add lucide paths to `ui/icon.tsx` |
| UUID ids | `Int @id @default(autoincrement())`, snake_case `@map`, `Timestamptz(3)`, `createdAt`/`updatedAt` on every table. Anything shared by link gets its own random `token` column (stored hashed) |
| Own auth, PBKDF2, sessions, CSRF | Managed core (`src/platform/auth`). Never write login, token, cookie or password code. Never create an admin |
| Stripe with a fetch client | Platform payments: price **keys**, `BuyButton` / `CheckoutSession`, `orders` and `memberships` tables |
| `StorageProvider` | Platform files: `createUpload` → browser `putFile` → `completeUpload` |
| `EmailProvider` | The platform relays only 7 fixed account emails. See §4 |
| `npm run jobs:*` scripts | Platform background jobs: `src/server/background.ts` + `background.json` |
| `date-fns`, `nanoid`, `cmdk`, `use-intl` | Not used. `Intl.*`, `randomBytes` + `toBase64Url` from `src/platform/auth/encoding`, own palette, own tiny i18n |

**Dependencies you may add, with the owner's approval, exact versions, no install scripts, each imported lazily inside the screen that needs it** (so first load stays under 250 KB gzipped):
`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (drag and drop with touch and keyboard), `fractional-indexing` (ordering), `@tanstack/react-virtual` (long lanes), `marked` (markdown, sanitized with the existing `xss` before render). Anything else: ask first. Run `npm audit --omit=dev` before saying "done".

## 4. Platform limits that shape the design (verified in the template docs)

1. **No WebSockets, SSE or Durable Objects.** Real-time is polling (§8).
2. **Background jobs:** 10 jobs added per minute by default (owner can raise to 50), 32 KB data, 60 s run, at-least-once. So **never one job per card, message or notification.** Scheduled jobs process bounded batches with a cursor.
3. **Email:** only `verify_email`, `password_reset`, `password_changed`, `account_exists`, `confirm_email_change`, `email_changed`, `sign_in_code`. **The platform sends no invite emails, no notification or digest emails, and has no inbound email.** In the MVP, invites are links the admin shares and notifications are in-app. **Invite emails come in Phase 11 and notification emails in Phase 12**, both through a third-party mail API with an owner secret (`config.ownerSecret`), called from a background job, fixed https origin, timeout, rate-limited. **Email-to-board is not planned.**
4. Account emails and managed auth messages are **English only**. Our UI maps stable error codes to localized text; the emails stay English until the platform localizes them. Tell the owner.
5. **Files:** the owner must turn on the Storage add-on and a pack. Max 100 MB per file, fixed type allow-list (no HTML or JS), no server-side thumbnails. Errors `E_STORAGE_*` must show clear messages.
6. **Payments:** a price is referenced by key, never by amount. Checkout `quantity` is 1 to 99, so **no per-seat pricing for 100-member teams: use flat workspace tiers.** Everything is sandbox until the owner connects a live gateway.
7. **Worker:** 128 MB, short CPU, at most 5 database round trips per request (independent ones in parallel), body limit 64 KB, responses about 200 KB at most, no `count()` per request, keyset paging only, explicit `select` always.
8. **CSP:** no inline `style=""`, no inline scripts, no third-party scripts, no CDN fonts. Computed styles are set with `element.style` or `style.setProperty` in effects. (ui.md says no `style={}`, security.md says React's prop is fine; use classes by default and verify drag and drop shows no CSP errors in the console.)
9. **No SSO or SAML** (auth is managed). **No email-to-board** (needs inbound email, easy to spoof or flood). Remove SSO and email-to-board from the roadmap.
10. The platform makes the owner/admin account. Billing mode, plan limits and workspace oversight are `/dashboard` screens gated by codenames (§7).

## 5. Features

### MVP (daily use)
1. Workspaces with members and roles (owner, admin, member, viewer), **join link** (revocable, expiring, optional max uses) and single-use invite links bound to an email. Neither is a sign-in link: the person signs in or registers first, then accepts.
2. Boards: create, star, archive, background (color, gradient, pattern, uploaded image), visibility (private, workspace, public-read link), create from template.
3. Lanes: add, rename, reorder, collapse, archive, color, WIP limit with a visual meter.
4. Cards: inline add (multi-line paste creates many), drag between lanes, reorder, duplicate, archive, move across boards.
5. Card panel in a **right slide-over** (route `/app/b/$boardId/c/$cardId`, Esc closes, resizable, bottom sheet on mobile): title, markdown description, labels (any color), members, start and due date, priority, estimate, checklists with progress, attachments (links and files), comments with @mentions, activity, cover.
6. Search and filters (text, label, member, due state, priority) and saved filters. Matches highlighted, others dimmed.
7. **Command palette** (Cmd/Ctrl+K) and shortcuts: `C` card, `N` lane, `/` search, `E` edit, `L` labels, `M` members, `D` due, `Space` assign me, `1-4` priority, `[` `]` move, `Shift+↑/↓` reorder, `Esc`, `?` cheat sheet, `G B` boards, `G M` My Day, `G C` chat.
8. **My Day:** cards assigned to me or due today or overdue across all workspaces, grouped Overdue / Today / Next 7 days.
9. **Inbox:** global quick capture into a personal Inbox board; triage later.
10. **Notifications** in app: assigned, mentioned, due soon, comment on a watched card, unread badge.
11. **Chat** (§5a).
12. Light, dark, system, high contrast; custom colors (§12); 20 languages (§11); installable PWA.
13. First-run onboarding: "Create a sample board from a template" (we cannot seed users, so the demo board is created for the signed-in user), invite teammates, try Cmd+K.

### 5a. Chat
- Conversation kinds: `DM`, `GROUP`, `CHANNEL` (`#general` created with each workspace), `BOARD` (auto-created per board, docked at the board edge).
- Messages: sanitized markdown, @mentions, **#card chips** that open the card, threads, reactions, edit and delete (soft), pin, unread divider, mute, search scoped to my conversations. Attachments use the files flow.
- Board links: **create card from message**, share a card into chat, optional system messages in board chat.
- **No typing indicators or presence in MVP** (a database write plus polling per event is not worth it). Revisit only if measured cheap.
- Sending is optimistic with a client `client_id`; `unique(conversation_id, client_id)` makes retries idempotent (catch `P2002`, return the existing message). Limit sends per user with a bounded query on `messages (sender_id, created_at)`.
- Admins can delete any message in channel and board chats, audited. Viewers are read-only in board chat. Messages never leak across workspaces.

### V1.1
Views of the same data (board, table, calendar, timeline, dashboard), swimlanes, custom fields, dependencies, recurring cards (daily schedule job, bounded batches), **Flows** (event → conditions → actions, run inline in the mutation transaction; time-based ones through one scheduled job), card and board templates, import and export (§5b), public share, activity feeds.

### V2
Paid plans and checkout (§10), reports (cycle time, throughput, workload), personal API tokens (random, hashed, revocable) and outgoing webhooks, **Add-ons** (GitHub, Slack, Google Calendar) using owner secrets from background jobs, ICS calendar feed (token route), email notifications (Phase 12, §4.3).

### 5b. Import and export
Body limit is 64 KB, so nothing big goes through the API. **Import from a Trello export:** the browser parses the JSON, shows a dry-run preview, then posts bounded chunks (about 40 cards per request) with `import_id` + `external_id` unique keys so reruns are idempotent. Members map by email. Attachments become links. Label it neutrally ("Import from Trello export"), no Trello branding. **Export:** paged GET routes assembled in the browser into a download, audited.

## 6. Data model (Prisma, our own tables only; never edit managed tables)

Conventions: `workspace_id` on every workspace-owned table (also copied onto lanes, cards, comments, attachments) and **first in its indexes**; one `@@index` per query shape ending in `id`; every FK column first in some index; explicit `onDelete`; `VarChar(n)` equal to the validator max; flags and small enums as `VarChar` + validator allow-list + CHECK in migration SQL; **no Json for anything filtered, sorted or joined** (typed columns). Json only for opaque snapshots (automation config, template payload, saved filter). `BigInt` for append-heavy tables (activity, messages), serialized as strings.

- **Profile:** `user_profiles(user_id unique → users ON DELETE CASCADE, locale, timezone, first_day_of_week, theme_mode, accent_hex, density, font_scale, radius, reduce_motion)`. Do not touch `users`.
- **Workspaces:** `workspaces(name, slug unique, plan, member_limit, storage_used_bytes, brand_accent_hex?, enforce_theme, default_locale, grace_until?)`, `workspace_members(workspace_id, user_id, role, @@id)`, `workspace_invites(token_hash unique, email?, role, expires_at, used_at?)`, `workspace_join_links(token_hash unique, role, expires_at, max_uses, uses, revoked_at?)`.
- **Boards:** `boards(workspace_id, name, visibility, bg_kind, bg_color_1, bg_color_2, bg_angle, bg_pattern, bg_file_id?, share_token_hash?, rev BigInt, archived_at?)`, `board_members`, `board_stars`, `lanes(board_id, workspace_id, name, position VarChar(64) COLLATE "C", color_hex?, wip_limit?, card_count, collapsed, archived_at?, updated_rev)`.
- **Cards:** `cards(board_id, lane_id, workspace_id, title, description_md, position VarChar(64) COLLATE "C", priority, estimate_minutes?, start_date?, due_date?, completed_at?, cover_file_id?, recurrence_*, checklist_total, checklist_done, comment_count, attachment_count, archived_at?, updated_rev, created_by (no FK))`, `card_members`, `card_watchers`, `labels(board_id, name, color_hex)`, `card_labels`, `checklists`, `checklist_items`, `comments(author_id no FK)`, `comment_mentions`, `attachments(file_id unique, card_id?, message_id?, name, content_type, size, ready)`, `card_links`.
- **Custom fields:** `custom_fields`, `custom_field_options`, `custom_field_values(value_text, value_number, value_date, value_bool, option_id)`.
- **Other board data:** `activity (BigInt)`, `notifications`, `flows(board_id, trigger_kind, enabled, config Json)`, `saved_filters`, `templates`.
- **Chat:** `conversations(workspace_id, board_id?, kind, name?, last_seq)`, `conversation_members(last_read_seq, muted_at?)`, `messages(BigInt id, conversation_id, seq, sender_id, body_md, parent_id?, client_id, edited_at?, deleted_at?, pinned_at?, kind)`, `message_reactions`, `message_mentions`, `message_card_refs`. Indexes `(conversation_id, seq)`, unique `(conversation_id, client_id)`, unique DM pair key.
- **Admin and billing:** `app_settings` (single row `id = 1`: `billing_mode` CHECK in `FREE_FOR_ALL`/`PAID`, `grace_days`, `maintenance_message`), `plan_limits(plan, max_members, max_file_bytes, storage_quota_bytes, max_flows)`. Plus the platform's `orders` and `memberships`.

**Ordering gotcha:** fractional-indexing keys must sort by byte order. Postgres default collation can sort them wrongly, so create `position` columns with `COLLATE "C"` in the migration SQL, and add an integration test against a real Postgres that reorders many cards. Moving a card updates one row; never renumber siblings.

**Counters on write:** `lanes.card_count`, `cards.checklist_total/done`, `comment_count`, `attachment_count`, `workspaces.storage_used_bytes`, `conversations.last_seq`. Change them in the same transaction as the row (`database.md`). Never `count()` per request.

**Account deletion cannot be intercepted** (managed). Personal content cascades, shared records use no FK or `SetNull` (show "Deleted user"). A daily cleanup job promotes an admin when a workspace has no owner.

Migrations: one at a time, `--create-only`, wrap in `BEGIN/COMMIT`, forward-only, safe for the previous code version, then `npx prisma generate`. Add every new table to the `TRUNCATE` in `tests/integration/support/harness.ts`.

## 7. Access control

- Site roles stay `owner` / `admin` / `member`. **Workspace and board roles are our own data** (the "Teams" recipe in `roles-and-permissions.md`): one helper `membership(db, workspaceId, userId)` in `src/server/workspaces.ts` used by every route; a board helper adds per-board overrides.
- Ids in URLs only select; access comes from membership read on the server per request, and `workspace_id` is in **every** `where`. Not yours or not found → **404**.
- Cross-links (card to board, label to card, file to message) must share the same `workspace_id`, checked in the query.
- Nobody grants a role above their own; nobody changes their own role except to lower it; the last workspace owner cannot leave or be demoted (one conditional write, 409).
- New catalogue entries in `src/server/permissions.ts` (no migration): `site:billing:manage` (ability `manageBilling`, owners only), `site:plans:manage` (`managePlans`, owners only), `site:workspace:read` (`readWorkspaces`, role `admin`; every staff access to someone's workspace is audited), `site:maintenance:manage`.
- Route order: `validator → withViewer → requireAuth → requirePermission (site screens) / membership (workspace data) → withDb`. Validators build objects field by field; never `data: body`.
- `audit()` for: role changes, joins and removals, join-link create and revoke, ownership transfer, deletes, exports, billing mode changes, staff access.
- Rate limits on our own tables (bounded query, example in `security.md` A06): messages, comments, invites, join attempts.
- Every guarded route gets an integration test of who may and who may not, including cross-workspace isolation.

## 8. Real-time without WebSockets (cheap polling)

Every poll is a billed Worker request plus database round trips, so polls must be one tiny query.

- **Board:** every write transaction increments `boards.rev` and stamps the changed row's `updated_rev` (archive instead of hard delete, so deltas see it). `GET /boards/:id/rev` is a single primary-key read. When it differs from the client's, `GET /boards/:id/changes?since=<rev>` returns changed lane and card summaries (index `(board_id, updated_rev)`).
- **Chat:** `GET /chat/pulse` returns `{conversation_id, last_seq}` for my conversations in one query. The client fetches messages only for conversations that moved (`seq > known`, keyset).
- Hook `useBoardSync(boardId)` and `useChatSync()` isolate the transport so a future push channel replaces them without touching screens.
- Intervals: about 5 s for the open board, 2 s only while a chat is open and active (back off to 10–15 s when idle), 30 s for the app-wide unread badge, **paused when the tab is hidden**, refetch on focus, jitter, backoff on errors. Measure at 100 users and tune.
- All user actions are optimistic with rollback and an **undo toast** for archive, move and delete.

## 9. Files (like Trello)

Follow `files.md` exactly: `POST /site-api/uploads` (our route validates workspace membership, role, type, size, plan limit, then `createUpload`) → browser `putFile` → `POST /uploads/:fileId/complete` (`completeUpload`, then mark `ready`, bump counters). Private by default. Downloads and previews go through our route (membership check, then redirect to a 5-minute link) so `<img src="/site-api/uploads/<id>/view">` works. Never save a `fileUrl()` link.
- UI: drag and drop onto a card or panel, paste images, picker, per-file progress, type and size shown before upload, image thumbnails (original file with CSS sizing), file-type icons, rename, delete, make cover, image lightbox with keyboard navigation, PDF opens in a new tab with `rel="noopener noreferrer"`.
- Board background images and avatars may be `public` files (`publicFileUrl`), because their links must be stable.
- Our limits sit on top of the platform's 100 MB: `plan_limits.max_file_bytes` and a per-workspace quota kept as a counter with one conditional `updateMany`.
- Chat attachments use the same flow. A purge job removes orphaned rows in bounded batches.

## 10. Billing mode and plans (admin switch)

> Changed per HANDOFF §2: default billing mode is `PAID` (not `FREE_FOR_ALL`), sandbox payments only, flat per-workspace plans, built in Phase 0.7 (not Phase 9).

- **Payments exist from day one, sandbox only** (no real gateway, no real money). `app_settings.billing_mode` is `PAID` (default) or `FREE_FOR_ALL`. A `/dashboard` screen with a Switch, confirm dialog and audit event, gated by `site:billing:manage`. Plan limits are editable on a second screen (`site:plans:manage`). All billing state lives in our own database (`plan_limits`, `workspaces.plan`, platform `orders` and `memberships`).
- `getEntitlements(workspace)` in `src/server/entitlements.ts` is the **only** place limits are decided (one primary-key read, memoized per request). `PAID` (default): limits enforced by plan, upgrade prompts shown, existing over-limit workspaces get `grace_days` then become read-only. `FREE_FOR_ALL`: premium features unlocked, plan limits not enforced (only safety caps), pricing and upgrade UI hidden. **Nothing is ever deleted by a mode switch.**
- Plans are **flat per workspace** (default guesses, editable): Free (10 members, 10 MB files, 1 GB), Pro (50 members, 100 MB, 20 GB), Team (100 members, 100 MB, 100 GB, audit log, roles). Storage quotas are bookkeeping; real space is the owner's storage pack.
- Built in **Phase 0.7** (not Phase 9). The owner's own test workspace is moved to Team through the sandbox checkout. Going live later = the owner connects a gateway; no code change expected.
- Checkout: create prices in sandbox with `npm run platform -- prices add --key pro-monthly …`. Our own route `POST /site-api/workspaces/:id/billing/checkout` checks the caller is workspace owner or admin, then calls `createCheckout` with `metadata: {workspaceId}`. The built-in `BuyButton` cannot carry metadata. `onMembershipChanged` in `src/server/payments-hooks.ts` updates `workspaces.plan` idempotently. Access only from `paid` or `membership` rows, never from the URL. Show `TestModeBadge` until a live gateway is connected.

## 11. Languages

- Launch set, 20 languages: `en` (source), `bn`, `hi`, `ur` (RTL), `ar` (RTL), `fa` (RTL), `es`, `fr`, `pt`, `de`, `it`, `ru`, `tr`, `id`, `zh` (Simplified), `ja`, `ko`, `vi`, `th`, `sw`. Adding a language is one catalog file plus one entry, so more (ta, te, mr, pa, ne, ms, nl, pl, uk, he, el, fil…) can follow without code changes. Not every language is possible: this is the chosen set, not "all".
- Own tiny i18n in `src/i18n/`: typed keys from `en`, `t(key, params)`, plurals through `Intl.PluralRules` with `_one` / `_other` suffixes, catalogs `src/i18n/messages/<locale>.json` loaded **lazily per locale**. A Vitest test fails if any locale lacks keys or placeholders that `en` has.
- No hard-coded UI strings, including toasts, empty states, shortcut sheet, palette, notifications, automation descriptions. Our routes return `error` codes and `fieldCodes` next to the English `message`; the client renders localized text and falls back to `message` for managed auth errors.
- Locale order: `user_profiles.locale` → cookie `lf_locale` (JS-writable, not sensitive) → `Accept-Language` → `en`. Picker in the account menu, onboarding and landing page. `<html lang dir>` set at boot. Prerendered pages cannot vary per visitor, so marketing stays English first; localized prefixes (`/bn/…`) come in the language QA phase.
- Dates, numbers and relative times with `Intl.*`; store UTC; per-user timezone and first day of week.
- **RTL:** logical CSS only (`margin-inline-start`, `padding-inline-end`, `inset-inline-*`, `text-align: start`); mirror directional icons; RTL languages are `ar`, `ur`, `fa` (and `he` later); test horizontal board scrolling and drag and drop in RTL (dnd-kit horizontal strategies need checking).
- **Fonts:** self-host `woff2` in `public/fonts` (`font-src 'self'`, `font-display: swap`, at most 2 weights): Plus Jakarta Sans (Latin). For every non-Latin language (bn, hi, ur, ar, fa, ru, zh, ja, ko, th) use good system stacks first and lazy-load a self-hosted Noto subset only for the active locale (CJK subsets are large: never in the first load). Bengali, Devanagari and Thai need line-height about 1.6. Urdu prefers a Nastaliq-style stack where available.
- First-pass catalogs for every language except `en` are machine drafts: mark them `needsReview` in a meta file for human review before launch.

## 12. Colors and original look

### Customizable colors
- All colors are CSS variables. Extend the template tokens (`--bg`, `--surface`, `--card`, `--ink`, `--muted`, `--line`, `--accent`, `--accent-hover`, `--accent-ink`, `--accent-soft`, `--accent-text`, status colors) in `src/styles/global.css`, **in all three places** (light `:root`, `[data-theme='dark']`, and the `prefers-color-scheme` block). No hex inside screens.
- One accent produces the whole palette: `--accent-hover`, `--accent-soft`, `--accent-text` derived with `color-mix(in oklab, …)`; readable foreground chosen by a pure, unit-tested `contrastRatio()` / `readableOn()` (WCAG AA); warn and auto-adjust if the chosen color fails.
- Settings → Appearance: 12 accent presets plus custom picker, mode (light, dark, system, high contrast), density, font scale, corner roundness, reduce motion, live preview, reset, export and import as JSON. Stored as **typed columns** in `user_profiles`, validated by allow-lists and a strict `#rrggbb` check. Never inject raw user CSS.
- Workspace brand accent plus an `enforce_theme` switch for admins. Board backgrounds: solid, gradient (two colors and angle), pattern or image, with an automatic scrim so lanes stay readable. Lane colors and label colors are any hex; label text color is computed for contrast.
- Apply at boot with `documentElement.style.setProperty` (allowed by the CSP) from a localStorage cache, then reconcile with the server profile. The SPA is `client:only`, so nothing paints before the theme is set and there is no flash. Board backgrounds are set on the canvas element through `element.style` in an effect.
- Default values (change in the token blocks): light bg `#FAFAF9`, surface `#F4F4F5`, card `#FFFFFF`, line `#E7E5E4`, ink `#1C1917`, muted `#78716C`, accent `#5B5BD6`; dark bg `#0F1012`, surface `#121316`, card `#17181B`, line `#26272B`, ink `#ECEDEE`, muted `#8B8D98`, accent `#7C7CF0`.

### Original, not a Trello copy
Do not recreate any product's layout. No Trello blue, no photo-first boards, no dark translucent columns, no centered modal for card details, no Trello names or assets. AGENTS.md also bans **one-sided colored stripes** (left or top borders, inset bars): show state with a dot, icon tile, badge, soft fill or a full 1 px border.
1. **Lane:** soft surface tinted from the lane color (full fill, about 10%), header with a color dot, name, count pill and WIP meter. No colored top bar.
2. **Card:** rounded surface with a full 1 px border; title first, label chips, ONE meta row (due, checklist n/m, comments, attachments, avatars; hide zeros); priority as an icon tile; optional small thumbnail on the right, never a big banner.
3. **Card details** in a right slide-over panel (resizable, pinnable) with the board still visible and draggable. Content on the left, properties rail on the right. Bottom sheet on phones.
4. **Floating bottom dock** for view switching and quick actions instead of top tabs.
5. **Chat dock** on the board edge; **My Day** is a first-class home screen.
6. Calm warm neutrals, one accent, generous whitespace, 4 px grid. Type-only wordmark.
- Type scale: page title 24/32 semibold, panel title 22/28, lane title 13/20 semibold, card title 14/20 medium, body 14/22, meta 12/16. Radius: card 10, lane 12, panel 16. Shadows: none at rest, small on hover, large while dragging (2° tilt). Lane width 288 px, gap 12 px.
- Interaction: optimistic everything, skeletons, 150 ms ease-out, drop-indicator line, inline editing, visible focus rings, `prefers-reduced-motion`, 44 px touch targets, keyboard drag and drop, aria-live announcements for moves, never color alone.
- Keep the template's shell rules: each route has `staticData.title`, focus moves to the `<h1>` after navigation, buttons show pending state, forms use `noValidate` and `useForm`, no `window.confirm`.
- After Phase 1 write `docs/product/visual-identity.md` (signature elements, spacing, motion, what we deliberately do differently from Trello) and follow it. This is design guidance, not legal advice; keep copy, icons and assets original or licensed.

### Reference screens (inspiration only, do not copy)
Todoist task panel https://mobbin.com/screens/4b5c4312-15b3-46ad-a335-2229893e03e6 · Motion task panel https://mobbin.com/screens/89b11d6b-f29b-428b-bbae-de4bc9ff4920 · Wrike board https://mobbin.com/screens/0636f1b9-6e3a-4358-8852-099c74d5705a · Programa board https://mobbin.com/screens/b0713e1b-1097-4828-bd2a-841bf0ff9bec · Remote palette https://mobbin.com/screens/2c863fcf-aab8-4a14-a85d-c6839d1b40f8 · Plane sidebar https://mobbin.com/screens/675ba224-6259-48bc-9cae-2bd3c712bf55. If a Mobbin connector is available, search "kanban board", "task detail panel", "command palette", "empty state", "onboarding checklist" before designing each screen.

## 13. Performance and scale (100 members per workspace)

- Budgets: SPA first load under 250 KB gzipped; each screen chunk under 50 KB gzipped (drag and drop, virtual list, markdown only inside the screens that use them); read CPU under 10 ms; at most 5 round trips per request; Lighthouse 95+ on public pages.
- **A board never loads all cards.** The board route returns all lanes (up to 50) and the first 15 cards per lane with one window-function query (`row_number() over (partition by lane_id order by position)` as a tagged `$queryRaw` template, values parameterized), then labels and members for those cards with `in` queries (2 more round trips). Hard cap about 150 cards and 200 KB per response; each lane has its own keyset "load more"; lanes beyond the cap load when scrolled into view. Document this choice, since it exceeds the usual 100-row guideline.
- Search: `contains` for small data; before thousands of cards add a `tsvector` column or `pg_trgm` GIN index in migration SQL (check the extension exists on Prisma Postgres).
- Member pickers, @mentions and assign lists use server-side search with `take ≤ 20`. Member directory is keyset paged.
- `workspaces.member_limit` is enforced with one conditional write when joining.
- Scale test: the harness's TEST database may insert users directly, so add a `seedScale()` test helper (100 users, 50 boards, 5,000 cards) and assert board load query counts and timing. (`prisma/seed.sql` may not create users.)

## 14. Quality gates

- Before "done": `npm run build` and `npm test` pass; integration tests run when `TEST_DATABASE_URL` is set (a throwaway Postgres; the tests EMPTY it). Pure-function unit tests: positions, contrast, i18n key parity, entitlements, rate checks.
- Run through the `security.md` checklist for every new route and page.
- There is no typecheck script in the template. Do not add tooling without approval; ask the owner if `typescript` should be added to devDependencies.
- Do not start a dev server yourself; the owner runs `npm run dev`. (AGENTS.md's machine-limit rules were written for the platform's editor sandbox.)

## 15. Phases (each agent finishes its assigned work, summarizes, stops; see HANDOFF.md §3 for the parallel plan)

- **Phase 0 Foundation:** read AGENTS.md and all `docs/agent/*`; local setup per README; `/app` host page and shell; auth settings; i18n scaffold; workspaces and members tables; `membership()` helper; codenames; `/dashboard` Billing mode screen with `app_settings` and `getEntitlements()`; tests.
- **Phase 0.5 Theme engine:** tokens, derivation, contrast helpers and tests, Appearance screen, workspace brand and enforce.
- **Phase 0.7 Billing (sandbox):** plans and `plan_limits` seed, `getEntitlements()`, sandbox prices (`npm run platform -- prices add --key pro-monthly ...`), `POST /site-api/workspaces/:id/billing/checkout`, `onMembershipChanged` hook, upgrade UI, `TestModeBadge`, `/dashboard` Billing and Plan limits screens, tests.
- **Phase 1 Board core:** boards, lanes, cards, fractional ordering with `COLLATE "C"` test, dnd-kit (mouse, touch, keyboard, verify CSP), optimistic updates and undo, activity, `rev` and `changes` sync. Then `docs/product/visual-identity.md`.
- **Phase 2 Card panel and files:** slide-over panel and every MVP card field, checklists, comments, mentions, link attachments, real uploads.
- **Phase 3 Speed:** filters, search, saved filters, command palette, shortcuts, My Day, Inbox, quick capture, onboarding.
- **Phase 4 Collaboration:** join links and invites, roles and tests, notifications, member directory.
- **Phase 4b Chat:** conversations, messages, pulse sync, unread, threads, reactions, #card chips, create card from message, tests for membership, idempotency and unread math.
- **Phase 5 Views:** table, calendar, timeline, dashboard, swimlanes.
- **Phase 6 Power:** custom fields, dependencies, recurring cards, templates.
- **Phase 7 Flows:** builder UI, inline engine, scheduled batch job for reminders and recurring cards (`background.json`, `npm run platform -- jobs`).
- **Phase 8 Migration and sharing:** Trello export import (dry run, chunks), CSV and JSON export, public `/b/<token>/` page.
- **Phase 9 Marketing:** pricing page, landing page, tests for both billing modes (billing itself is Phase 0.7).
- **Phase 9b Language QA:** review catalogs by priority, RTL pass (ar, ur, fa), CJK and Thai font pass, localized public pages.
- **Phase 10 Polish:** PWA (manifest, service worker in `public/`, CSP-safe), virtualization, accessibility audit, empty states, error boundaries.
- **Phase 11 Invite emails:** send the existing invite link by email through a third-party mail API (owner secret), from a background job; one scheduled job sending bounded batches (never one job per email); templates localized in all launch languages; per-workspace send rate limit; delivery failure shown to the inviter; the link still works if email fails. Owner actions: mail account, verified sending domain (SPF, DKIM), API key.
- **Phase 12 Notification emails (decide after the team has used the MVP):** per-user on/off and frequency settings, digest batching by one scheduled job with a cursor, unsubscribe, idempotent sends, localized. Build only the notification types the team actually misses.

> Changed per HANDOFF §3/§5: Phase 0.7 (Billing, sandbox) added after 0.5; Phase 9 trimmed to pricing page, landing page and tests for both billing modes; the old "finish a phase and stop" rule is replaced by: each parallel agent stops when its ASSIGNED work is done and does not start another phase; one worktree, branch and Postgres database per agent; one branch merged at a time with `npm run build && npm test`.

At the end of every phase output: what was built, how to run and test it, assumptions, owner actions needed, and what comes next.

## 16. Owner actions (the agent cannot do these)

1. Turn on **Storage** and a pack, or uploads answer `E_STORAGE_NEEDS_PACK`.
2. Set the owner email (`SITE_OWNER_EMAILS` on the platform) so an owner exists on the live site.
3. Approve the optional dependencies in §3.
4. Connect a live payment gateway when ready; until then checkout is sandbox.
5. Have native speakers review the 19 non-English catalogs (start with bn, hi, ur, ar, es, fr, the ones your users speak).
6. Raise the background job rate in the Jobs tab if reminders or emails need it.
7. For Phase 11: create a mail-API account, verify the sending domain, and add the API key as an owner secret.
