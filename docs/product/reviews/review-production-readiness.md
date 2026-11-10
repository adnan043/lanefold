# Production readiness review (read-only, 2026-11-03)

Scope: go-live steps (Prepare, Build, Migrate, Deploy) checked against the repo. No code changed, no build or install run.

## Blockers

None found in code. Launch is gated only by the owner actions below (uploads and plan checkout do not work until they are done).

## Should-fix

1. **Template `/jobs/` pages are still public and indexable.** `src/pages/jobs/index.astro` and `[slug].astro` render for everyone (`/site-api/jobs` too); the list page has no `noindex`, only the sitemap hides them (`PRIVATE` regex in `sitemap.xml.ts`). `robots.txt` does not disallow them. Either delete the pages and route (and the `jobs` dashboard screen if unwanted), or add `noindex`. A random "Jobs" board on a kanban product looks unfinished.
2. **`/robots.txt` disallows `/app` and `/dashboard`** although its own comment says these rely on `noindex` (a Disallow hides the tag). Harmless for signed-in pages, but the comment and the rules disagree; pick one.
3. **Owner-actions doc is stale**: `docs/product/owner-actions.md` item 7 lists two pending migrations; there are three (add `20261103051050_memberships_workspace_last_event`). Item 1 lists `@tanstack/react-virtual` and `marked` as deps; neither is in `package.json` or imported (fine, but the doc should say so).
4. **All of the work is uncommitted** (large `git status`: modified template files, untracked `src/app/`, both new migrations, `public/images/`). The owner publishes from the working copy so this works, but nothing is in git history beyond the 2 initial commits; commit before Publish so a rollback exists.
5. **Public/unauthenticated GET routes are not rate limited**: `/site-api/jobs`, `/jobs/sitemap`, `/site-api/site`. Reads are bounded and keyset-paged, so low risk, but they are the only public costly reads (auth endpoints use the platform limiter; invite, checkout, comments, chat, uploads have their own soft limits).
6. **Soft limits are on the Site Cache** (`src/server/soft-limit.ts`): they reset on cache eviction. Acceptable, but do not treat them as a hard security control.

## Nice-to-have

- Sweeps: all three are keyset paged and bounded (`MAX_PAGES`, `DELETE_BATCH`, `MAX_DELETE_BATCHES`); `sweepEndedMemberships` and `cleanupOld` do per-row awaits (one `updateMany` + grace + audit per downgraded workspace; up to 4x25 `deleteFile` calls sequentially). Fine for the Worker CPU limit at launch scale; watch if the daily downgrade count grows into the hundreds.
- `sweepGrace` / `sweepEndedMemberships` use `JOIN` without a supporting index on `workspaces(plan)` or `grace_until`; table is small now, add an index if workspaces exceed tens of thousands.
- Partial index migration for cards is raw SQL only; `prisma migrate dev` will not drift on it, but a future `migrate diff` may want to drop it. Keep the comment in the migration.
- `style={{transform, transition}}` in `src/app/boards/card.tsx` and `lane.tsx` (dnd-kit) is applied by React through the CSSOM client-side only (`client:only="react"`), so the CSP does not block it. Verify once in the deployed app (DevTools console, no CSP violations while dragging).
- `docs/agent/` copies may be older than the live docs: run `npm run platform -- docs` in the editor before the final pass.

## Owner actions before launch

1. Set `SITE_OWNER_EMAILS` (the admin account is created from it; sign in at `/dashboard` with the emailed code).
2. Create sandbox prices `pro-monthly` and `team-monthly` (`npm run platform -- prices add --key ... --name ... --amount-cents ... --currency ... --interval month`). Until both exist, billing shows "Payments are not set up yet" and checkout answers 404 `e_price_not_found`.
3. Turn on Storage and add a Storage pack in the app's Storage tab; until then uploads fail with `E_STORAGE_NEEDS_PACK` (message exists in `en.json`, and the app handles it).
4. Custom domain (and then confirm `siteUrl` / canonical URLs, sitemap and RSS use it).
5. Publish from the editor: Prepare, Build (`npm ci`, `npm run build`), Migrate, Deploy. Three migrations will apply on the live database: `20261102120928_lanefold_mvp` (seeds `app_settings` PAID, 14 days grace, and the three plans), `20261102124901_cards_board_open_idx`, `20261103051050_memberships_workspace_last_event`.
6. After deploy, move the owner's test workspace to Team through the sandbox checkout to prove the flow; check Platform > Jobs shows the three schedules.
7. Going live with real money is a platform-side switch (connect a live gateway); no code change expected, see payments guarantee below.

## Evidence

- **package.json vs lock**: root `dependencies` and `devDependencies` in `package-lock.json` are identical to `package.json` (node comparison: true/true). `npm ls --depth=0` clean, no extraneous/missing/invalid entries (site-app@0.10.10; astro 7.3.8, @astrojs/cloudflare 14.3.4, prisma 7.10.1, hono 4.13.13). Exact-pinned new deps: @dnd-kit/*, fractional-indexing, @stripe/stripe-js (`@stripe/stripe-js` is installed; no direct use found outside platform/checkout, OK). `build` script runs `prisma generate` first, so ignored `src/generated` is rebuilt.
- **Migrations**: 10 in order (init, site_auth, seed_roles, job_deliveries, account_security, sign_in_codes, payments, lanefold_mvp, cards_board_open_idx, memberships_workspace_last_event). Every file has one BEGIN/COMMIT pair. No DROP/TRUNCATE/DELETE FROM in any file. Newest two: `CREATE INDEX ... WHERE archived_at IS NULL` on cards (plain, non-concurrent, inside a transaction, fine for a new table); `ALTER TABLE memberships ADD COLUMN last_event_at, workspace_id` (both nullable, no default, no rewrite) plus an index on (workspace_id, status). Old rows keep NULL workspace_id; the plan sweep explicitly never matches them, so no accidental downgrade. `prisma migrate status` against the local DB: "Database schema is up to date" (10 migrations).
- **Background**: `background.json` lists plan-sweep, grace-sweep, old-data-cleanup (daily 04:00/04:20/04:40 UTC, retries 3, concurrency 1); `src/server/background.ts` defines exactly those three handlers (via `scheduledJobs` in `src/server/jobs/index.ts`). `npm run platform -- jobs`: "background.json: ok (3 lists, 3 schedules)". Handlers are idempotent (conditional `updateMany` on read plan; bounded delete batches; `DontRetry` on bad data). No `sendJob` callers yet (no ad-hoc jobs).
- **Env**: no `process.env` or `cloudflare:workers` use outside `src/platform/config.ts` (only `import.meta.env.DEV` build flags in `middleware.ts`, `lib/seo.ts`, `lib/posts.ts`, `portal/routes.tsx`, and `scripts/platform.mjs` using `SITE_DIR`, a CLI script). `scripts/seed-demo.ts` is local-only.
- **Secrets**: grep for sk_live/sk_test/whsec_/AKIA/private keys/postgres URLs with credentials hits only `README.md`, `docs/agent/cache.md`, `src/platform/cache-guard.ts` (documentation/guard patterns; values not printed). `.gitignore` covers `.env`, `.dev.vars`, `*.local`, `src/generated`, `.platform/`, `dist`, `.astro`, `.wrangler`, `node_modules`. Tracked: only `.env.example`.
- **Headers / CSP**: `public/_headers` matches `src/platform/headers.ts` (nosniff, Referrer-Policy, Permissions-Policy, COOP same-origin, X-Frame-Options DENY, HSTS 15552000). Astro `security.csp` is on, with hashes for emitted scripts/styles. Inline `<script>`/`<style>` in `.astro` files (BuyButton, TestModeBadge, PriceList, CheckoutAskForm, login/register/reset/verify/forgot/confirm-email, checkout, thanks, Base, App) are processed blocks (no `is:inline`), so they are hashed. `set:html` only for JSON-LD in `Base.astro` (`jsonLdText`). No inline handlers, no `style=""` in `.astro`; TSX `style={}` only in dnd-kit (see above). `connect-src 'self'`, `frame-src` limited to YouTube/Vimeo.
- **Caching**: `/app/*` page calls `pageContext()` which sets `Cache-Control: private, no-store`; billing responses also `private, no-store`; guards set no-store. Page is `prerender = false`, signed-out visitors get a sign-in prompt (the API re-checks every call).
- **Sitemap/robots**: sitemap excludes account, portal, site-api, dashboard, app, jobs; robots allows `/`, disallows `/site-api/`, `/app`, `/dashboard`, `/account/`, and lists the sitemap. Error pages `404.astro`, `500.astro` exist; `/jobs/[slug]` returns 404/503 with noindex.
- **Payments sandbox guarantee**: repo code never selects a mode: it passes through `checkout.mode` from the platform and the platform decides sandbox vs live (live only after the owner connects a gateway). No hard-coded amounts or third-party checkout scripts; prices come from the catalogue keys `pro-monthly`/`team-monthly` in `plan_limits.price_key_monthly`. `payments-hooks.ts` accepts `test` and `live` events (signed by the platform) and is idempotent (stale-event check by event time). Therefore: no live path is reachable from the repo itself; sandbox-only holds as long as no live gateway is connected on the platform.
- **Rate limits**: auth endpoints via the platform limiter (`platform/auth/rate-limit.ts`); app routes: board creation (1h), checkout (10 per 10 min), comments, chat messages, conversation starts, invites, invalid invite-link attempts, unfinished uploads. Gaps: see Should-fix 5.
- **`npm run platform -- check`** needs the template folder (not available here); not run further. Build, test, and a live Preview were not run in this read-only pass.
