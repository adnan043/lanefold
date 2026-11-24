# Rules for AI agents working in this app

The single source of rules for EVERY coding agent (Claude Code, Codex, Cursor…).
The other rule files at the root (`CLAUDE.md`…) only import this file: edit here, never there.

This repo is ONE site: a website AND its own app, in one Astro project on ONE
Cloudflare Worker (`output: 'server'`, `@astrojs/cloudflare`). It stands alone: it owns its
users, sign-in, roles and data in its own Site Database. It already works end to end:
prerendered marketing pages, a blog, a job board, sign-up/sign-in/password reset, two-step
sign-in, change email, signed-in devices, delete account, the owner's way in from the dashboard
("View as admin"), a dashboard with user and role admin, a backend and a database. Extend it; don't
rebuild what is here.

Placeholders written as double braces around an UPPER_CASE name are filled in by the platform.
The filled-in copy, which wins over this file when they differ, is what the editor
gives you (`/etc/claude-code/CLAUDE.md`, `{{DOCS_DIR}}/`); outside the editor,
`npm run platform -- docs --site <a hosted site's address>` saves it to `.platform/docs/` (start with `core.md`).
**A placeholder still in double braces is not filled in** (on a developer's own computer, or any copy
outside the editor): never fetch, open or paste it as a URL, path or value, and never fill it in (this file
is compared byte for byte). Read `docs/agent/<topic>.md` in this folder instead of `{{DOCS_DIR}}` or
`{{DOCS_URL}}`; for any other one, `DEVELOPERS.md` or `STORE-LISTING.md`, if present, says what it is on
that computer; otherwise it isn't available there: do the task without it and say so in one line.

## First: is this site on the required template version? (0.10.26)
Read `version` in `template.json` at the start of a session, new or resumed, before anything else. **If it's below 0.10.26, this site
has problems these rules can't fix for it:** from packages with known security problems (below 0.10.26 and 0.10.17), the owner's
own payment provider (below 0.10.24) and the platform's video (below 0.10.23) to account takeover (below 0.10.16); `upgrade.md`
"What each version fixed" lists them all.

**Upgrade it now, as your first step, without asking.** The owner won't know what to answer, and nothing reaches visitors until they
publish. Say one plain line, such as "I'm updating your site first. Hold off publishing until I'm done, then I'll do what you asked", follow
`upgrade.md`, then do their task. A question from the owner that changes nothing can be answered first. Upgrade before anything that
changes a file. No `template.json` means this site wasn't built from a template: skip this. A `.review/REVIEW.md` means this is a read-only review copy: never upgrade it. If `.platform/upgrade-failed` holds this required version, an upgrade already failed: skip it, do their task, and say so in one line. If the owner has said not to upgrade, do their task, and upgrade next session unless they say no again.
If it can't finish, `upgrade.md` says how to put everything back: then do their task and say so in plain words. Never patch
these problems by hand in your own code, and never publish a half-done upgrade.

**On a developer's own computer.** If `DEVELOPERS.md` exists at the top of this project, read it first: it says how this
copy is set up and kept up to date. There an upgrade is a `git merge` of the template's newest release, not `upgrade.md` step 1
(`upgrade.md` "On a developer's own computer" has the commands). Never edit the template's own files (listed under
"Architecture" below): they are compared byte for byte with the release `template.json` names (`npm run platform -- check`), a store
submission that changed or deleted one is refused, and `git checkout v<the version in template.json> -- <file>` puts one back.
Before saying a store listing is ready: `DEVELOPERS.md` "For your AI".

## Every task: the current rules first, then the owner's words
These rules are kept up to date by the platform and can be newer than this site's code, which stays
as it was built. The owner is not an engineer: they say WHAT they want; HOW is yours, by these rules.
1. Before each task, re-read the current rules (`/etc/claude-code/CLAUDE.md` in the editor, for every
   agent; else `{{DOCS_URL}}` on this site's address) and the topic doc for that work (below), even
   mid-session: they may have changed since you last read them. Never work from memory of them.
2. Then do what the owner asked, the way these rules say.
3. Code the task touches or depends on that breaks a current rule: bring it up to the rule in the same
   task when it matters (security, lost or wrong data, a broken page, a slow query or page,
   accessibility). Something minor: leave it and say so in one short line. Never rewrite parts of the site the task does not need.
4. A doc names something this site does not have yet (a helper in `src/platform/`, a script command):
   its platform code is older than the doc. The required version above comes first. Otherwise never add
   it inside `src/platform/` (managed); do the task in your own code (`src/server/`, `src/pages/`…) following the doc's pattern.
   Asked for a security check, or asked to go live for the first time: run "The full security check" in `review.md`.
5. Before saying it's done, check it works: `npm run build`, `npm test` (integration tests too when `TEST_DATABASE_URL`
   is available: `database.md`), the page in the Preview, and `security.md`'s checklist.
6. **Then review it, every task that touched a route, a query, a page that reads data, a permission,
   a form, a payment, a job or an outside call: run `review.md` (security with AUTHORIZATION first,
   then performance), fix what it finds, and end your answer with its short report.** No exceptions
   for "small" changes: most leaks are one missing `where`.

## How changes go live
You edit a working copy; the OWNER publishes from the editor: Prepare → Build (`npm ci`,
`npm run build`) → Migrate → Deploy (`publishing.md`). You cannot publish. Keep `npm run dev` working at `/`.


## The Preview, git and the machine in the editor (NON-NEGOTIABLE)
- The editor runs the Preview's dev server on ONE fixed port: Astro 4321, TanStack Start 3000, a Static site 8788, or
  the port the project's own config names. Never start your own (`npm run dev`, `astro dev`, `vite`, `npm run preview`,
  `wrangler dev`), never pass `--port`, never kill it: each Preview start stops whatever holds that port.
- See it and restart it with `{{PREVIEW_COMMAND}} status`, `{{PREVIEW_COMMAND}} logs [-n N]` (the end of `{{PREVIEW_LOG}}`) and
  `{{PREVIEW_COMMAND}} restart` (the owner's Restart button). No `{{PREVIEW_COMMAND}}` (an older editor): read `{{PREVIEW_LOG}}` and ask
  the owner to press Restart. **Preview broken: follow `preview.md`** (status, logs, then the usual causes: port taken,
  missing packages, crashed server, stale generated file, merge conflict).
- Generated files are never edited by hand (`src/routeTree.gen.ts`, `src/generated/`, `.astro/`, the editor's root
  `wrangler.jsonc`): change their source and regenerate.
- `git status` first: a platform import can leave the project mid-merge. Unmerged files or `<<<<<<<` markers: finish that
  merge before anything else (`preview.md`).
- `origin` is the platform's git proxy: `git push` works only while the editor session is open and answers 403 after it
  ended. Never change the remote or ask for a token.
- A variable or secret the owner adds reaches the Preview only at the next Open, and that Open stops every process in the
  sandbox, yours included: commit first, then ask the owner to reopen the editor.
- You share CPU and memory with the Preview and the editor: read them (`nproc`, `free -m`,
  `cat /sys/fs/cgroup/memory.max`) before heavy work; stop and clean up under ~15% free memory or when load stays above
  the CPU count. Kill what you start; no watchers (`vitest run`). One heavy command at a time (`npm install`, build,
  `prisma generate`, tests). Bound every command (no `find /`, no grep over `node_modules`). Every dependency is a cost:
  never a second UI kit, date or state library.

## Topic docs: read the one that fits BEFORE that work
Read the current copy: `{{DOCS_DIR}}/<topic>.md` in the editor, else `{{DOCS_URL}}/<topic>.md` on this
site's address. `docs/agent/<topic>.md` in this repo is the copy from when the site was built or last
upgraded and can be older; when they differ, the current copy wins:

| Doc | Read it before |
| --- | --- |
| `ui.md` | ANY dashboard screen, form, table, dialog, button, style or UI dependency (the UI kit) |
| `auth.md` | anything about who the visitor is, sign-in, sessions, passwords, account emails |
| `roles-and-permissions.md` | gating a feature, an admin screen, a new permission or role |
| `security.md` | any route, form, query, HTML, outbound call, secret, log line; before "done" |
| `review.md` | the END of every task that touched server code or data (the security + performance review, with its report) |
| `performance.md` | any query, list, page, dependency, image, font, cache or loop |
| `cache.md` | a read that runs on many requests (settings, hours, menus, categories, products, page text, totals), a slow page, or saving data a cached read shows |
| `upgrade.md` | this site's `template.json` is below the required version, or the owner asks to upgrade |
| `database.md` | the schema, a migration, seed data, an index, a new model, how the database connection behaves |
| `seo.md` | a new public page, titles and descriptions, URLs, social cards, sitemap, robots.txt, RSS |
| `site-api.md` | any server route or backend code |
| `background-jobs.md` | anything that happens later, on a schedule, with retries: reminders, follow-ups, summaries, cleanups |
| `files.md` | anything that stores a file a person picks (photos, documents, attachments, avatars, audio) or shows one back |
| `video.md` | any video people watch in the app: lessons, courses, a video library, members' or product videos (upload, play, who may watch) |
| `preview.md` | the Preview is broken, blank or stale; the dev server, its port or log; a generated file; a merge left half done |
| `publishing.md` | git, scripts, dependencies, config, redirects, going live |
| `payments.md` | anything sold: a Buy or Subscribe button, a price, checkout, a membership or paid page, orders, refunds |
| `payments-providers.md` | selling with the OWNER's own Ezypay, Stripe or PayPal account (every store app that sells): the owner picks in the admin, keys, checkout, webhooks, cancel, access |
| `orders-and-stock.md` | anything charged, booked or limited: bookings, tickets, seats, stock, coupons with a limit, your own payment provider |
| `plans-catalogue.md` | the platform's plans an owner resells (sign-up links to their studio), not the site's own products; their real plans: `npm run platform -- plans --write` |
| `store-apps.md` | submitting this app to the store, its sign-in page, its roles, or anything an admin can save: the read-only demo admin (`prisma/demo-login.sql`, `npm run platform -- demo-login`, `<DemoLogin />`) |

**Anything charged, booked or limited → `orders-and-stock.md`**: an idempotency key (`idempotent()`), and the database
decides what's left (one conditional statement, a unique index or a short lock; never read-check-write, never the cache).
**Selling anything → `payments.md`**: built in, sandbox while you build; never a third-party checkout script or a hard-coded
amount. **An app that sells (a store listing), or an owner who asks for their own account → `payments-providers.md`**:
Ezypay and the owner's own Stripe and PayPal, the OWNER picks in the app's admin (`src/platform/payment-providers/`);
never one provider hard-coded, keys only from the owner's secrets.

**Files and video → the platform's own, ALWAYS (`files.md`, `video.md`).** Never offer, suggest or scaffold the owner's own
bucket, S3, R2 or a video host; video is the built-in upload or an embed, never a direct file link. No storage or video
yet: tell the owner (the dashboard's **Storage** page) and stop. Only an owner who asks in so many words gets their own
storage (`files.md` says what to tell them). Video is for teaching, coaching, talks and business: never movie, TV-drama or
music-video features; refuse those in one plain line (`video.md` "What video is for").

## Architecture: one Worker, Hono is the backend
```
browser ──► Astro page (the view) ──in-process──► Hono /site-api ──► Site Database / platform API
browser ──► /dashboard (React SPA) ──── fetch ─────► Hono /site-api
```
- **Hono (`src/server/app.ts`, `src/server/routes/*`) is the ONLY backend.** Validation,
  guards, database and platform calls live in Site API routes. Pages only render.
- **Pages call it in-process** with `backend(Astro.request)` / `pageContext()` (`src/server/`).
- **`src/platform/` is the MANAGED core** (config, platform client, guards, the whole auth
  system in `src/platform/auth/`, browser helpers, sanitizer). Never edit it:
  `npm run platform -- upgrade` replaces it (that is how security fixes reach this site).
  `docs/agent/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `template.json`, `CHANGELOG.md`, `scripts/platform.mjs` and
  `scripts/managed-files.json` are managed the same way (`npm run platform -- check` compares them). Your code: `src/server/`, `src/pages/`, `src/portal/`,
  `src/content/`, `src/lib/`, `src/styles/`, `prisma/`.
- **One Worker, one build, one deploy.** No second Worker, no KV/R2/D1/queues/Durable Objects.
  Later and scheduled work is the platform's background jobs (`background-jobs.md`): handlers in
  `src/server/background.ts`, schedules in `background.json`, `sendJob()` to send. A cache, when one
  is justified, is the platform's Site Cache (`cache.md`, `cache.getOrSet` from
  `src/platform/cache.ts`), never your own.

| Path | What | Code |
| --- | --- | --- |
| `/`, `/about/` | marketing (STATIC) | `src/pages/index.astro`, `about.astro` |
| `/blog/`, `/blog/<slug>/` | the blog: Markdown files, prerendered | `src/content/blog/*.md`, `src/pages/blog/`, `src/content.config.ts` |
| `/jobs/`, `/jobs/<slug>/` | job board: a list page (static shell + JSON) and a server-rendered job | `src/pages/jobs/` |
| `/account/*` | login, register, forgot, reset, verify (STATIC + script) | `src/pages/account/` |
| `/dashboard/*` | signed-in dashboard: account, users, roles, activity, jobs (SPA) | `src/portal/` |
| `/portal/*` | the dashboard's old address: redirects to `/dashboard/*` with its query (the platform's one-click sign-in opens it); keep it | `src/pages/portal/[...path].astro` |
| `/site-api/*` | the backend | `src/server/`, `src/platform/auth/` |
| `/sitemap.xml` | public pages, posts, open jobs (SSR, cached 1 h) | `src/pages/sitemap.xml.ts` |
| `/robots.txt`, `/rss.xml` | crawler rules, the blog feed (STATIC) | `src/pages/robots.txt.ts`, `rss.xml.ts` |
| — | error pages: any miss (404), a page that failed on the server (500) | `src/pages/404.astro`, `500.astro` |
| — | `<head>` SEO (title, description, canonical, Open Graph, Twitter), header, footer | `src/layouts/Base.astro`, `src/lib/seo.ts` |

Public page URLs END WITH `/` (`/about/`, `/blog/<slug>/`, `/jobs/`): prerendered pages are
served there (`/about` costs a redirect), and the canonical URLs and sitemap use that form.
Link with the slash.

Never create pages under `{{API_PREFIX}}` (the platform's) and never add `/login`, `/register`, `/forgot`,
`/reset`, `/verify-email` at the root: sign-in pages live under `/account/`.

## Environment
Read ONLY through `config` (`src/platform/config.ts`), server code only. Names are the platform's
contract: you cannot rename or add them, and you cannot add secrets (never ask for one).

| `config.` | Platform name | What |
| --- | --- | --- |
| `siteUrl` | `{{SITE_URL_ENV}}` | the site's own address, where the platform answers `{{API_PREFIX}}/*` (`{{SITE_ORIGIN_PATTERN}}` or its custom domain; plain var) |
| `preview` | `SITE_PREVIEW` | `1` only in the editor Preview |
| `databaseUrl` | `DATABASE_URL` | the Site Database (Preview Database in the editor) — secret |
| `jwtSecret` | `JWT_SECRET` | signs access tokens, keys rate-limit hashes — secret |
| `ownerSecret('NAME')` | an owner-added secret | another service's API key the owner added (a payment provider, mail, SMS, AI…: `security.md` › Calling other services); `null` when not added |
| `siteKey` | `{{SITE_KEY_ENV}}` | the Site Key (`{{SITE_KEY_PREFIX}}…`) for `{{SITE_API_PREFIX}}/*` (relayed emails) — secret |

- No `DATABASE_URL` → routes answer 503 `site_database_disabled`; no `JWT_SECRET` → auth answers
  503 `auth_not_configured`. Tell the owner; don't work around it.
- Deployed server code may `fetch` public APIs with keys only from `config.ownerSecret` (`security.md` › Calling other
  services); never the platform's internal network (`403 Egress blocked`), raw TCP, outgoing WebSockets or native modules.
  Account emails, files, jobs and payments are built in (`site-api.md`, `payments.md`): prefer them.
- Never send a secret to the browser, log it, write it to a file (`.env`, `.dev.vars`) or commit it.

## Auth in one paragraph (details: `auth.md`)
Site-owned: `users` + scrypt passwords, a 10-minute HS256 access JWT and a rotating
opaque refresh token in `__Host-` HttpOnly Secure SameSite=Lax cookies, CSRF double-submit,
rate limits in `login_attempts`, account emails relayed by the platform. In a route:
`validator → withViewer → requireAuth → requirePermission('site:x:y') → withDb`; the user is
`c.var.viewer.id`. In a page: `pageContext()` → `viewer.state === 'user'` (gated:
`pagePermission()`). In the browser: `siteFetch()` or the portal's `api`, never a plain
`fetch` (in the editor Preview the session travels only through them: `publishing.md`). Never
write login, token, cookie, password or two-step code yourself. The admin is the account's owner: they open it
with "View as admin" on the app's page in the dashboard, or the shield in the Preview's bar. That's
the only way in, with no password or sign-up, so never create, seed or change an admin. Other admins
are made in its Users screen. Say exactly that when they ask how
to reach the admin, and put the app's admin screens inside `/dashboard`.
On a developer's own computer with no Site Key: `auth.md` (local codes, `dev-admin`, never an owner).
After any sign-in, someone who can open the admin lands in it (`/dashboard/`): every sign-in page, yours too, goes to the `next` the route answers.

## Which kind of page (decide FIRST, every time)
| The page is… | Build it as |
| --- | --- |
| Signed-in and interactive: dashboard, CRM, admin, settings, any form-driven screen | **SPA**: a screen in `/dashboard` (`src/portal/screens/`) |
| One thing that must rank or be shared: a product, a job, a post | **Server-rendered**: `src/pages/<name>/[slug].astro` (a Markdown post is built ahead) |
| A list long enough for filters, search or load more: all jobs, all products, search results | **List page**: a static shell, rows from a JSON route (`performance.md` "List pages") |
| A short list that fits on one page and should rank: a small category | **Server-rendered**: no load more, so the whole list is in the HTML |
| The same for everyone: home, about, pricing, forms that only post to the API | **Static**: `export const prerender = true`. Scripts and islands still run, and a dynamic part loads as JSON |

Keep the server's part small. Never server-render a long list, and never send a whole page again to change a filter.
- NEVER build a signed-in app as one `.astro` page per screen (full reloads, flashes, repeated
  session lookups). An app is ONE catch-all page hosting React; screens are client routes.
- NEVER move a public or SEO page into the portal. Public pages stay real pages with plain
  `<a href>`, navigated CLIENT-SIDE by `<ClientRouter />` (in `Base.astro`, keep it) and made
  instant by prefetch (`data-astro-prefetch` on links to PRERENDERED pages only). A `<script>`
  on a public page runs ONCE per visit: put its work in `document.addEventListener(
  'astro:page-load', () => { … })`, return early when the page's own element is missing, and
  keep `history.state` when you `replaceState` (`performance.md`).
- Inside the portal: TanStack Router `<Link>` (never a plain `<a href>` to a portal path: it
  reloads the app), `navigate()` after a save, invalidate the query.
- Never put visitor data in a static page's HTML: it is one file served to everyone. Fill it in
  the browser (`data-user-only`, `data-guest-only`, `data-live` sections built with `textContent`).

## A dashboard looks like a dashboard (`ui.md`)
The dashboard ships finished (shell, overview, users, roles, activity, jobs, account), all from ONE UI kit in
`src/portal/ui/`; see it at `/dashboard/components` in the Preview. Build every screen from the kit; keep the shell (tab
title and focus on the route's `<h1>`); every screen has its loading, empty and error states; edit in a `Drawer`, confirm
with `useConfirm`, never `window.confirm` / `alert`; no hex, no `style={}`, no second UI kit, no hero or marketing copy in
an app. The full rules: `ui.md` "A dashboard looks like a dashboard".

## Buttons and forms (NON-NEGOTIABLE, every page, every time)
Read `ui.md` "Buttons and forms" before any form or button, on any page. In short: a button shows pending (spinner,
"Saving…", `aria-busy`, disabled) while it runs, never sends twice, and ends with the result or the error in words. Every
form is `noValidate`; every field has a visible `<label>` and its error under it (`aria-invalid`, `aria-describedby`);
submit validates all and focuses the first wrong field; client rules mirror the server's; every password field has
show / hide (`PasswordInput`, `bindPasswordReveal()`).

## Recipes (details in the topic docs)
- **A Site API route**: `site-api.md` (guards in order, validator, explicit select, keyset page).
- **A portal screen** (all of it, every time; `ui.md` "A new screen, start to finish"): reads as `queryOptions` /
  `infiniteQueryOptions` in `src/portal/queries.ts`; the screen in `src/portal/screens/<name>.tsx` from the kit; in
  `src/portal/routes.tsx` a `createRoute` (literal path, `staticData: {title}`, a `loader` with
  `queryClient.ensureQueryData`, `lazyRouteComponent`), `routeTree` and a `NAV_GROUPS` item with its `icon`;
  gated: an `ability` on its catalogue entry (`/me` and `Abilities` follow).
- **An admin-only feature**: ONE entry in `CATALOGUE` (`src/server/permissions.ts`: codename,
  title, group, `ability`, default `roles`; no migration) and its line in `tests/permissions.test.ts`, routes behind
  `requirePermission(PERMISSIONS.X)` (own records: `can`), nav item `ability: '<ability>'`
  (`roles-and-permissions.md`). Never gate on a role slug.
- **A list + detail** (like `/jobs`): data route first; the list copies `src/pages/jobs/index.astro` (`performance.md`
  "List pages"); the detail copies `src/pages/jobs/[slug].astro`: 404 + `<NotFound>` when the route answered 404, 503 +
  "not available" when the read failed (an outage is never a 404); outside HTML only via `sanitizeHtml`.
- **A blog post: add a Markdown file** `src/content/blog/<slug>.md` (the file name is the URL;
  never rename a published one). Front matter is checked at build by `src/content.config.ts` (read it):
  `title`, `description`, `publishedAt` required; a `cover` file in `src/assets/blog/` (1200×630) is optimised at build;
  `draft: true` shows only in the Preview. Headings from `##`. It goes live with the next Publish, with the list, RSS,
  sitemap and home page. No blog/CMS API: never fetch posts. Never paste untrusted HTML into Markdown.
- **A static page**: `src/pages/<name>.astro` with `prerender = true`, `staticContext()`,
  `<Base isStatic title description>`; words in `src/content/site.ts`; add it to `NAV`. It is in
  the sitemap automatically (`seo.md`).
- **A collection of content in the repo** (team, FAQ, services): a content collection in
  `src/content.config.ts` like `blog` (`glob()` for Markdown, `file()` for one JSON/YAML file)
  with a strict schema, read with `getCollection()` in a prerendered page. Create the data file
  FIRST, then the collection (one added before its file exists stays empty until `{{PREVIEW_COMMAND}} restart`).
  Content the OWNER edits on the live site (without a Publish) is not a collection: it is a table (next item).
- **A new table (model)**: `database.md` (`@@map`, lengths, an `@@index` per query shape, `migrate dev --create-only`,
  BEGIN/COMMIT, `migrate dev`, `npx prisma generate`), then a Site API route (`site-api.md`), then the page or screen.
- **A file upload** (photos, documents, attachments): `files.md`. Your route checks THIS feature's own limits first
  (types, a size that fits it, who may upload), then `createUpload()`; the browser sends the bytes with `putFile()` (the
  page calls `allowFileUploads()`); your route confirms with `completeUpload()` and keeps the file id in your own table.
  Private by default; show files through your route (it checks access, then redirects to a short link).
- **Video people watch** (lessons, a course, a library): `video.md`. Only through `src/platform/video.ts`: never store,
  serve or proxy video bytes yourself. Check who may watch by THIS app's rules first, then a fresh `playback()` link per
  viewer, every view, never cached or shared; a guest's sends `guest: true` and the visitor's IP (`viewerIp`).
- **Something to sell** (a product, a booking fee, a membership): `payments.md`. Create the
  sandbox price (`npm run platform -- prices add …`), put `<BuyButton price="<key>" />` on the
  page, record what was bought in `src/server/payments-hooks.ts`, gate member pages with
  `requireMembership` / `pageMembership`.
- **Something later or on a timetable** (a reminder before a booking, a daily email, a
  cleanup): `background-jobs.md`. A handler in `src/server/background.ts`, `sendJob()` from the
  route (with a `key`), a schedule in `background.json`, `npm run platform -- jobs` to check.
- **An image**: the file in `src/assets/`, rendered with `Cover` (`src/components/Cover.astro`)
  or `<Picture>` from `astro:assets` in a PRERENDERED page (optimised at build). Images in SSR
  pages and the portal are served as they are: commit them resized, or use the CDN's sizing.
- **A separate app at its own path** (`/crm`) only when asked: ONE host page
  `src/pages/crm/[...path].astro` copied from the portal's, its own router with
  `basepath: '/crm'`, the portal's shell and UI kit.

## Production rules
- The deployed Worker has limits (128 MB, short CPU): bounded queries, keyset paging, no whole-table loops, nothing big
  in module memory (`performance.md`).
- Visitor data only in the request scope; module memory only for small public caches.
- Every platform call has a timeout and every page a fallback for `null`.
- **Queries: no N+1, ever.** One query per read (nested `select`, one join with `relationJoins`; an
  aggregate or several tables as ONE tagged `$queryRaw`), never a query inside a loop; independent
  reads in `Promise.all`; at most ~5 sequential round trips per request (`database.md`,
  `performance.md`).
- **The database connection is the platform's** (`src/platform/db-socket.ts`, one WebSocket per
  request). Use `getDb()` / `c.var.db`; never open your own session, never edit that file. A query is
  ~3 ms. A lost connection re-sends a read but NEVER a write: guard anything a person may repeat with
  a unique key. No `String[]` columns. Details and a site without that file: `database.md`.
- **The owner comes only from "View as admin" in the dashboard** (`auth.md`, `src/platform/auth/owner.ts`). No sign-up,
  email, code, password, setting or migration makes an owner, and someone signing up with the owner's
  email is a normal user. Never add another way in. The owner's `viewer.email` is empty, and the site never
  knows their address: to email them, send kind `notification` with no `to`.
- **Cache reads that repeat, and never show old data.** Every query is billed; a cache read isn't. Fix the query first, then
  cache what many requests read and rarely changes. Trace each read: who reads it, is it the same for all, every place that changes
  it (clear it in each), what if it's old. Never money decisions, access or edit screens. Read `cache.md` first; say what you cached and why.
- **Raw SQL only as a prepared statement**: the tagged `` $queryRaw`…${value}…` `` / `Prisma.sql` /
  `Prisma.join`; never `$queryRawUnsafe`, `$executeRawUnsafe`, `Prisma.raw(input)` or SQL built
  from strings. Names (columns, sort) only from a fixed map.
- **Every route is authorized on the server**: a permission guard, the owner/team IN the query's
  `where` (not checked after loading), not found → 404, fields set field by field, output through
  `select`; and an integration test that another user gets 404 (`roles-and-permissions.md`).
- Webhook and payment handlers are idempotent; outside calls have a timeout; slow work goes to a
  background job; anything public and costly is rate limited (`security.md`).
- A cached read is `cache.getOrSet(key, ttl, load)` with a TTL you CHOOSE from the data (1 minute to 7 days,
  `cache.md` "How long to keep it"); every route that saves it calls `cache.del` / `delPrefix` right after the write.
  Never cache sessions, permissions, carts, or the prices a quote or order charges.
- **Redirects**: exact ones may stay in astro.config `redirects`; a catch-all (`[...rest]`) never goes there (the publish
  fails): `public/_redirects`, `/old/* /new/:splat 301` (`publishing.md`).
- Keep `@astrojs/cloudflare` 14.x, npm + committed `package-lock.json`, no wrangler config,
  `imageService: 'compile'` (build-time only; never a runtime transform), `session: false`,
  `security.csp` on, `public/_headers` in step with `src/platform/headers.ts`.

## Never
- **Send a password, in ANY form, to ANYONE, the user included**: not plain, hashed (`passwordHash`),
  encrypted or masked; not in a response, an email ("your password is…"), a page, a log, the cache,
  an export, an error or an outside service. A forgotten password gets a reset link, never the
  password. The same for sign-in codes, tokens, recovery codes and secrets once issued.
- **Send another person's email address anywhere others can see it.** An email is treasure: it
  leaves the server ONLY to its own owner, or to a signed-in admin whose permission the server
  checked (`site:user:read`). Never in a public page or API, a list, a search result, a comment or
  author line, an error ("that email is taken by…"), a URL, a log, analytics, a cache key or value
  others can read, or an outside service the person didn't ask for. Show a name instead; if a
  person must recognise an address, mask it (`m•••@gmail.com`). Never copy emails into your own
  tables (join on `users.id`).
- Edit `src/platform/**`, `docs/agent/**` or another managed file (above), weaken a guard, `sameOrigin`, `csrf`,
  the rate limits, the cookie flags or the CSP, or write auth, token, cookie or password code.
- Put a secret in code, a file, a log, the browser or git; read `env` outside `config`; ask for
  a secret's value; call another service with a key from anywhere but `config.ownerSecret`, or
  send it a user's data the feature doesn't need.
- Trust input: every route validates type, length and format with `hono/validator`; no
  `data: body` spreads, no ids, roles or owners from the client.
- `$queryRawUnsafe`, string-built SQL, `set:html`/`innerHTML` with data, `style=""` attributes
  or inline handlers (the CSP blocks them), `target="_blank"` without `rel="noopener noreferrer"`.
- Unbounded or un-indexed queries, offset paging, `count()` per request, a query per row,
  awaiting independent reads one after the other.
- `Cache-Control: public` on anything that read the visitor (`pageContext`, `withViewer`).
- `setTimeout`/`setInterval` for later work, or a page someone must visit to run it: send a job.
- Offer, suggest or scaffold the owner's own storage (a bucket, S3, R2, a video host's account) when they didn't
  ask for it in so many words, or play video from a direct file link (`<video src="https://…mp4">`).
- A signed-in app as one `.astro` page per screen, a second UI kit, a second lockfile.
