# Public read-only board page `/b/<token>/` (design for owner approval)

Status: proposal, no code written. Sources: AGENTS.md, SPEC (section 3 routes, section 5 boards, section 7 data, Phase 8), HANDOFF, `docs/agent/security.md`, `seo.md`, `cache.md`. Where this file and those conflict, they win.

## 1. What a visitor sees

The page is a snapshot of one board, read only, no sign-in, no JavaScript needed for the content.

Shown:
- Board name, background (color, gradient, pattern; uploaded background only if its file is `public`), workspace name and brand accent.
- Lanes (name, color, card count) and non-archived cards in order: title, labels (name + color), due date, priority, checklist progress (n/m), cover color or image if `public`, and the card description rendered from sanitized markdown (read in a `<details>` per card, no card panel route).
- Assignees as a **display name only** (policy in section 2), never an avatar URL that could reveal a file id.
- A small footer: "Shared with Lanefold" and a link to the home page. A "Report this page" link (mailto-free: a POST form to a rate-limited route).

Never shown (enforced by an explicit `select` list, not by hiding in the template):
- Any email address, user id, workspace member list, roles, invite or join links.
- Comments, activity feed, mentions, watchers, notifications, saved filters.
- Attachments of any kind (files and links), including private file ids and short links. Link attachments are also hidden because the URL can be a secret.
- Chat (channel, board chat, messages), card links to other boards, archived lanes and cards, deleted users.
- Custom fields marked private (none in MVP), estimate, time tracking, the inbox board.
- Plan name, limits, billing state.

Member names policy (recommended default): show first name plus last initial ("Maria K."), or the user's display name if it has no space; owner can switch the board to "hide all names" (`share_show_names = false`). Names are never linked and never emailed. A deleted user shows nothing.

## 2. Who may create, what a link is

- Create, rotate, revoke, change expiry, toggle names: **board admin** or workspace admin/owner (new permission codename `site:board:share`, ability `shareBoard`, entered in `CATALOGUE`, no migration; check by workspace membership role in the query `where`, never by role slug). Board editors and viewers cannot. Staff cannot create links, only revoke (audited).
- One **active** link per board (simplest to reason about). Rotate = revoke old + create new in one transaction.
- Board `visibility = 'public'` is the on/off switch. Turning visibility to private or archiving the board makes the link answer 404 at once (the link row is kept so turning it back on does not need a new token only if not revoked; default: turning off does NOT revoke, it hides).
- Inbox boards (`inbox_of` not null) can never be shared.
- Plan limits (extend `plan_limits` with `public_boards` Int and `public_link_max_days` Int, read only through `getEntitlements()`): Free 0 public boards, Pro 5, Team 50; link expiry at most 90 days on Pro, no limit (or 365) on Team; Free may not create a link, with the upgrade prompt. Over-limit or downgrade: existing links keep working through the grace period (`grace_until`), then answer 404 until the count is under the limit (newest kept disabled first, oldest enabled). The limit check on create is a conditional write inside a transaction (count active links `where workspace_id`), never read-then-write.

## 3. Token

- 32 bytes from `crypto.getRandomValues`, base64url, 43 characters, 256 bits. URL: `/b/<43 chars>/`.
- Stored only as `SHA-256(token)` hex, 64 chars, unique. A fast hash is correct here because the token is high entropy, not a password. Nothing derived from the token is stored (no prefix column; the UI shows "created 3 Nov, ends 2 Dec", never the token again).
- The plain token is returned **once**, in the create/rotate response, together with the full URL; the owner copies it. Lost link = rotate. (Choice: not reversible by design.)
- Lookup: `SELECT ... WHERE token_hash = $1`, constant-time compare unnecessary because the unique index lookup is by hash (no timing oracle on the secret). Malformed tokens (not 43 base64url chars) answer 404 before any query.
- Revoke: sets `revoked_at`; effective on the next request (the link check is never cached).
- Expiry: `expires_at` optional on Free/Pro-allowed plans, default 30 days on creation with "never" allowed on Team; an expired link answers 404 (same body as unknown, so no oracle). A background job (daily) marks expired links and writes an audit row; the request check also tests `expires_at > now()`.

## 4. Schema sketch

Replace the single `boards.share_token_hash` column with a table (so expiry, revoke, history and view counts have a home). The column is left unused in the migration and dropped in a later one.

```prisma
model BoardShareLink {
  id          Int       @id @default(autoincrement())
  boardId     Int       @map("board_id")
  workspaceId Int       @map("workspace_id")
  tokenHash   String    @unique @map("token_hash") @db.Char(64)
  showNames   Boolean   @default(true) @map("show_names")
  expiresAt   DateTime? @map("expires_at") @db.Timestamptz(3)
  revokedAt   DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdBy   Int?      @map("created_by")          // no FK to users: SetNull-like, shows "Deleted user"
  lastViewDay DateTime? @map("last_view_day") @db.Date  // coarse, one write per day max
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId, revokedAt])
  @@index([workspaceId, revokedAt, expiresAt])   // limit count and the expiry job
  @@map("board_share_links")
}
```

Add `plan_limits.public_boards`, `plan_limits.public_link_max_days`. Partial unique index (one active link per board) in raw SQL inside the migration: `CREATE UNIQUE INDEX ... ON board_share_links (board_id) WHERE revoked_at IS NULL`. Migration plan per `database.md`: `migrate dev --create-only`, edit SQL (BEGIN/COMMIT, partial index, seed plan numbers), `migrate dev`, `npx prisma generate`. No data to move (no links exist yet). Writes by `site-api` only.

## 5. Routes and queries

Owner-side routes (`src/server/routes/board-extras.ts`, guards in order: validator, `withViewer`, `requireAuth`, workspace membership + `requirePermission`, `withDb`):
- `GET /site-api/boards/:id/share` : status only (active?, expiresAt, showNames, createdAt). Never the token. Where: board id AND workspace membership in the query. Other workspace: 404.
- `POST /site-api/boards/:id/share` : create (body: `expiresInDays`, `showNames`). Entitlement check, one transaction. Returns `{url}` once. Rate limit 10/hour per user.
- `POST /site-api/boards/:id/share/rotate`, `PATCH .../share` (expiry, showNames), `DELETE .../share` (revoke). All audited, all 404 for non-admins and other workspaces.

Public read (no `withViewer`, so no cookies are read and nothing is personalised):
- `GET /site-api/public/boards/:token` called in-process by `src/pages/b/[token].astro` (SSR, `prerender = false`). Reads:
  1. Link + board (one query, unique index on `token_hash`, join `boards` by PK): `link.show_names, link.expires_at, link.revoked_at, board.id, board.rev, board.visibility, board.archived_at, board.name, bg_*, workspace name, accent`. Any failed condition: 404.
  2. Content (cached, section 6): ONE tagged `$queryRaw` returning lanes and cards with labels aggregated (`json_agg`), assignee first names; bounded: at most 20 lanes, 500 cards per lane (the existing safety cap), `ORDER BY lanes.position COLLATE "C", cards.position COLLATE "C"`. Indexes already needed by the board view: `lanes(board_id, position)`, `cards(board_id/lane_id, position)`; no new index beyond the table above.
  Two round trips, independent of board size. Description markdown is rendered and sanitized on the server when building the cached payload.
- `POST /site-api/public/boards/report` for abuse reports (section 8).

Responses: 404 JSON/HTML identical for unknown, revoked, expired, private, archived, malformed. 503 only on a database failure (never 404 for an outage), as `jobs/[slug].astro` does.

## 6. SSR vs cache

SSR, never prerendered (token space is unbounded, revocation must be instant). Headers: `Cache-Control: private, no-cache` (the page is not personalised, but it must not be stored by shared caches past a revoke), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`.

Site Cache (`cache.getOrSet`), content only: key `pubboard:<boardId>:<rev>` (rev from query 1), TTL 1 hour. Because the key contains `boards.rev`, which every write transaction bumps, a card or lane edit changes the key and **no invalidation call is needed**; old keys simply expire. The cached value holds no token, no hash, no email, no secret, only the already-sanitized public payload. Revocation, expiry and visibility are checked in uncached query 1, so they are immediate. Changes the rev does not cover (workspace rename, member display name change, `show_names` toggle) call `cache.delPrefix('pubboard:<boardId>:')` in the saving route. The `show_names` variant is part of the key (`...:<rev>:n1` / `n0`).

## 7. noindex, robots, OG

- `<Base noindex secretInUrl>`: `noindex`, no canonical, no Referer, no OG image generated from board content.
- Not in the sitemap, not in RSS, not linked from any public page.
- `robots.txt`: do NOT `Disallow: /b/` (crawlers must see `noindex`; per `seo.md` Disallow does not remove URLs and Disallow would reveal the path pattern).
- OG/Twitter: generic only (title "Shared board", description "A board shared with Lanefold", the default site card). The board name is **not** put in OG tags, so a link pasted in Slack or WhatsApp does not unfurl private content. Owner can opt in later (decision 5).

## 8. Rate limiting and abuse

- Per IP hash: 120 page views per minute on `/b/*` (fixed window). Per IP hash, **failed lookups** (404): 20 per 10 minutes, then 429 with `Retry-After`; this makes guessing 2^256 tokens moot and cheaply blunts scanners. The managed limiter cannot take new kinds, so the counters live in our own small table or the Site Cache; the choice follows `security.md` "Limit what costs" (own table `public_view_attempts(ip_hash, window, count)` with a daily cleanup job, or cache counters). IP is hashed with `config.jwtSecret`, never stored raw, never logged.
- Per-link ceiling: 600 views/minute across all IPs (cheap cached payload makes this safe); above it, 429 and an audit event once per hour.
- Report form: 5/hour per IP hash, reason from a fixed list, creates an audit row and a notification to workspace admins; staff can revoke a reported link through `site:workspace:read` access, audited.
- Responses never differ in timing or body between not-found reasons. No token in logs: the access log line uses the route pattern `/b/:token`, and errors never echo the path.

## 9. CSP and markdown

- The page needs no inline script. Under the template's `security.csp` (no inline styles/handlers): no `style=""`; board background and label colors are applied as CSS classes from a fixed palette set plus `data-*` read by a tiny external script, or via a `<style>` block through Astro's CSP hash support. Custom hex colors (`bg_color_1`) are validated as `#RRGGBB` at write time and emitted only through that mechanism. No `set:html` of anything but sanitized markdown.
- Markdown: `marked` then the existing `xss` allow-list (no `img`, `iframe`, `style`, `form`, `svg`; `a` only `http/https/mailto`-less, forced `rel="noopener noreferrer nofollow ugc" target="_blank"`). Images in descriptions are rendered as plain links (no tracking pixels, no hotlinking from the public page). Sanitization happens on the server before caching and **again** inside the page via `sanitizeHtml` (defence in depth). `img-src` stays `'self'` plus the CDN for `public` files only.
- `frame-ancestors 'none'` (the page cannot be iframed), `Referrer-Policy: no-referrer`.

## 10. Audit events

`audit()` rows (actor, board id as target, ip hash, small meta, never the token or hash): `board.share.create`, `board.share.rotate`, `board.share.revoke`, `board.share.update` (expiry, names), `board.share.expire` (job), `board.share.disable_plan` (limit enforcement), `board.share.report`, `board.share.rate_limited` (once per hour per link), `board.share.staff_revoke`. Viewing is NOT audited per request (volume, privacy); only `last_view_day` is stored, one write per day at most.

## 11. Tests (vitest, integration where DB is needed)

1. Token: 43 chars, base64url, unique across 1000 draws; only the hash is stored; plain token absent from DB, response of GET status, logs, audit meta.
2. Create/rotate/revoke permissions: board admin ok; editor, viewer, other workspace, signed-out all 404/401; staff revoke only.
3. Plan limits: Free 403 with upgrade code; Pro 6th link rejected; concurrent creates cannot exceed limit; expiry cap enforced; downgrade disables links.
4. Public read: valid link returns board; revoked, expired, private visibility, archived, inbox board, malformed token all return the same 404.
5. Leak test: serialized payload contains no `@`, no attachment, comment, chat, user id, file id, `passwordHash`; fixtures have emails, comments, attachments with known marker strings that must not appear.
6. Names policy: `show_names` false hides names; deleted user shows nothing.
7. Markdown XSS corpus (script, onerror, `javascript:` href, svg, nested html, data URI): output safe; images become links.
8. Headers: `noindex`, `no-referrer`, `frame-ancestors 'none'`, `Cache-Control` not public, no OG with board name; not in sitemap or RSS; robots has no Disallow for `/b/`.
9. Cache: second view is a hit; a card edit (rev bump) shows new content; revoke is immediate while a cached payload exists; cached value has no token.
10. Rate limit: 21 bad tokens in 10 minutes return 429; good traffic from another IP unaffected.
11. Query count: page makes at most 2 DB round trips; no N+1 with 500 cards.
12. Idempotence: double rotate in parallel leaves exactly one active link (partial unique index).

## 12. Threat table

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Guessing a token | 256-bit token, 404 for all misses, failed-lookup rate limit | none practical |
| DB leak reveals links | only SHA-256 hashes stored, no prefix | none |
| Link forwarded or posted publicly | expiry, one-click revoke/rotate, names hidden option, no-index | owner awareness; the link is a bearer secret by design |
| Token leaks through Referer or logs | `no-referrer`, `secretInUrl`, route-pattern logging | browser history/extensions |
| Search engines index it | `noindex` header + meta, not in sitemap, not Disallowed | none |
| Private data over-exposure (emails, comments, files) | explicit `select`, separate payload builder, leak test with marker strings | new fields added later: tests must be extended (checklist in PR template) |
| Stored XSS via markdown | server and page sanitization, strict CSP, no images | sanitizer bug (kept patched through `xss` upgrades) |
| Link survives revoke through cache | link check uncached, content keyed by rev | up to one request in flight |
| Enumeration via error differences | identical 404 body/timing | none |
| Scraping/DoS of costly page | rate limits, 2 round trips, cached payload, bounded lanes/cards | volumetric DoS (platform edge) |
| Cross-workspace access when creating a link | board id AND membership in `where`, 404 otherwise, integration test | none |
| Plan abuse (links past limit, Free workspace) | conditional write in transaction, grace job | none |
| Share a board then workspace member leaves | link is workspace-owned, not user-owned; remains until revoked | owner decision |
| Embedding/phishing look-alike | `frame-ancestors 'none'`, report form, staff revoke | content the owner wrote is shown as is |

## 13. Decisions for the owner (yes/no, recommended answer first)

1. Show assignee names (first name + last initial) on public boards by default, with a per-link switch to hide all names? **Recommended: Yes.**
2. Allow public links on the Free plan? **Recommended: No** (Pro 5, Team 50 boards; Free sees an upgrade prompt).
3. Default expiry of 30 days on every new link (Team may choose "never")? **Recommended: Yes.**
4. Hide link attachments and all comments forever on the public page, with no per-board option to show them? **Recommended: Yes.**
5. Keep the board name and cover out of the OG/Twitter preview (generic card only)? **Recommended: Yes** (opt-in later if wanted).
