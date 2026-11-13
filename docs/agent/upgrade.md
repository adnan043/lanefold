---
title: Upgrading a site to the current template
read-when: this site's template.json is older than the required version in AGENTS.md, or the owner asks to upgrade
---
A site's code stays as it was built. Rules reach it at once, but fixes only reach it through an upgrade and a
Publish. Below the required version, upgrade as your first step without asking (`AGENTS.md`). Nothing reaches visitors until they publish.

## Steps
Start with a clean git tree: commit what's there. Never stash: Publish ships the working copy, so stashed work would be left out of it.
1. Apply the template. In the editor, the platform puts it in `{{TEMPLATE_ZIP}}` when the editor opens. If it isn't there yet, wait a few seconds and look again:
   ```bash
   rm -rf /tmp/site-template
   mkdir /tmp/site-template && unzip -q {{TEMPLATE_ZIP}} -d /tmp/site-template
   npm run platform -- upgrade --from /tmp/site-template
   ```
   If its `template.json` is still below the required version, or the file never arrives, treat it as "If it can't finish" below. Never ask the owner to download or find anything: they have nowhere to get it. Plain `npm run platform -- upgrade` fails with `no template folder`: always pass `--from`.
   A developer on their own machine (a clone of the template's repository, its `upstream` remote): merge the newest release tag instead (`AGENTS.md` "On a developer's own computer"), then continue at step 2. No `upstream` remote: add the template's repository as `upstream` (`DEVELOPERS.md` names it) and merge; there is no copy to download. `npm run platform -- check` says whether a newer release is out.
2. It replaces the managed files, adds new ones, and lists what it left as it was. Go through that list. Keep this site's own changes.
   **Check its `added` list first.** A page or content file there is one this site deleted or never had. Delete anything added under `src/pages/`, `src/content/`, `src/assets/` or `public/`, unless a step below names it or the build needs it. A visitor must never see a page the owner didn't ask for.
3. **Every upgrade, whatever version this site is on**, because `package.json` and `prisma/schema.prisma` are usually on that list. A site on 0.10.11 can still be missing some of it. Skip what's already there:
   - `package.json` → `dependencies`, these exact versions: `"@prisma/driver-adapter-utils": "7.10.1"`, `"@prisma/ppg": "1.0.1"`,
     `"pg-types": "4.0.2"`, `"postgres-array": "3.0.4"`. On another Prisma version, move Prisma to the template's first.
   - `prisma/schema.prisma`:
     - in `model User`: `platformOwnerId String? @unique @map("platform_owner_id") @db.VarChar(64)`
     - in `model AuthState`: `ownerEnvId String? @map("owner_env_id") @db.VarChar(64)`
     - in BOTH `generator` blocks: `previewFeatures = ["relationJoins"]`
     - the new `model IdempotencyKey`, copied whole from `/tmp/site-template/prisma/schema.prisma`
   - Packages with known security problems (0.10.17). `package.json` → `devDependencies`: `"vitest": "4.1.12"`. Then, after `npm install`
     in step 9, run `npm audit fix` (never `--force`) and `npm audit`: it must report no high or critical problem. If one is left, it comes
     from a package this site added: update that package to a version without it, or tell the owner which package it is.
   - The new migration folders arrive with the upgrade. Never edit them.
   - Checkout keys, so a double click or a retry can't start a second checkout. Copy these five from `/tmp/site-template/`; if this site
     changed one, bring the `idempotency` and `paid` lines into its copy instead: `src/lib/idempotency.ts`, `src/lib/checkout-session.ts`,
     `src/lib/checkout-transport.ts`, `src/lib/buy-button.ts`, `src/server/routes/checkout.ts`.
   - The page progress bar, for an older site (an optional extra, skip it if it clashes): copy `src/lib/page-progress.ts`, the `.page-progress` block at the end of `src/styles/global.css`, and the `installPageProgress` lines in `src/layouts/Base.astro` and `src/portal/PortalApp.tsx`.
   - Anything this site charges, books or limits with its own code: bring it up to `docs/agent/orders-and-stock.md`, and tell the owner what you changed.
   - In this site's own code, remove anything that makes an owner: `ownerEmails` in `src/server/auth-settings.ts`, a hardcoded address,
     a seeded admin, a read of `SITE_OWNER_EMAILS` or `config.ownerEmails`. To email the owner, send kind `notification` with no `to`.
   - A `String[]` column: move it to a related table or `Json` (`database.md`).
   - The template's own tests: copy them over, because old copies check old behaviour: `cp -R /tmp/site-template/tests/. tests/`. Tests this
     site added stay. If it changed one of the template's tests, redo that change after copying.
4. **Coming from below 0.10.13.** The upgrade adds `src/lib/list-page.ts`, but usually leaves these for you. Skip what's already there:
   - `src/layouts/Base.astro`: the `preloadData` prop and its `<link rel="preload">` line, copied from `/tmp/site-template/src/layouts/Base.astro`.
   - `src/styles/global.css`: the `.list-skeleton` block and its `@keyframes`, copied from the end of the template's copy. If this site's colours differ, keep its own `--line` value.
   - `src/pages/jobs/index.astro`, if this site has one. Unchanged from the template: copy the template's. Changed: convert it to a list page (`performance.md` "List pages") and keep this site's words and look. Then remove `prefetch: false` from the Jobs link in `src/content/site.ts`.
   - `tests/list-page.test.ts` checks the template's `/jobs/` page. If this site changed or removed that page, change those checks to match.
   - Any other long list this site has stays as it is until a task touches it.
5. **Coming from below 0.10.15** (sign-up now needs a code, and no account exists before it). The migration arrives with the upgrade. Skip what's already there:
   - `src/pages/account/verify.astro`, `src/pages/account/register.astro`, `src/pages/account/cancel-email.astro`, `src/lib/account.ts`, and the `needsCode` lines in `src/pages/account/login.astro`. Unchanged from the template: copy them. Changed: keep this site's look, and bring across the code form and the flow.
   - Any page or portal screen of this site's own that posts to `/site-api/auth/register` must then send the person to `/account/verify/`. An old form would only show a message, with nowhere to type the code, though the link in the email still works in that browser.
   - Delete `tests/rate-limit-lock.test.ts`: the template removed it, and it fails against the new limits.
   - `requireEmailVerification` in `src/server/auth-settings.ts` no longer does anything: delete it. Search this site's code for `verify_email`, `email_unverified` and `/register`, and bring anything that uses them up to `auth.md`.
6. **Coming from below 0.10.18** (local development mode, a safer sample seed). The managed files arrive with the upgrade; these are left to you. Skip what's already there:
   - `prisma/seed.sql`: unchanged from the template's old copy (sample jobs, `WHERE NOT EXISTS (SELECT 1 FROM "jobs")`): copy `/tmp/site-template/prisma/seed.sql`. Changed by this site: keep its rows, and make it follow `database.md` "Seed and tools": `BEGIN;` … `COMMIT;` around it, a `DO $$ … $$` block first that stops with `RAISE EXCEPTION` when this site's real data is there, and inserts that are safe twice. No seed: nothing to do.
   - `.env.example` and `README.md`: if this site still has the template's, copy the template's `SITE_KEY` and `JWT_SECRET` comments and the README's "Building it on your own computer" part. A site that rewrote them: leave them.
   - `AGENTS.md` (and `CLAUDE.md`, `GEMINI.md`): the upgrade leaves them, but they are the template's rules. Copy the template's. If this site added rules of its own to `AGENTS.md`, add those lines back at the end. An app built for the store keeps all three exactly as the template has them (its own notes go in `README.md`).
   - `package.json` → `scripts`: add the template's `check`, `setup`, `db:migrate`, `db:seed` and `dev-admin` lines where this site has none of that name.
   - `docker-compose.yml`, `.nvmrc` and `.editorconfig` arrive as new files (the local database, the Node version, editor settings): keep them.
   - `tests/local-dev.test.ts` arrives with the tests in step 3.
7. **Coming from below 0.10.19** (the template's own files are checked). The upgrade adds `scripts/managed-files.json` (this release's
   list of the template's own files) and `.gitattributes` (LF line endings, also on Windows): keep both. Then:
   - `AGENTS.md`: the upgrade leaves it; copy the template's (`cp /tmp/site-template/AGENTS.md AGENTS.md`). If this site added rules
     of its own to it, add those lines back at the end. An app built for the store keeps it exactly as the template has it.
   - Run `npm run platform -- check --from /tmp/site-template`. It lists any of the template's own files that differ from this release
     (`src/platform/`, `docs/agent/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `template.json`, `CHANGELOG.md`, `scripts/`): copy each
     one from `/tmp/site-template/` (keep this site's own lines of `AGENTS.md` at its end, as above). "Windows line endings":
     `git add --renormalize .`, then check again.
8. **Coming from below 0.10.20** (clearer steps on a developer's own computer). The upgrade leaves these; skip what's already there:
   - `AGENTS.md`: copy the template's (`cp /tmp/site-template/AGENTS.md AGENTS.md`). If this site added rules of its own to it, add
     those lines back at the end. An app built for the store keeps it exactly as the template has it. `CLAUDE.md` and `GEMINI.md` are unchanged.
   - `tests/integration/account-security.test.ts` arrives with the tests in step 3.
   - `src/server/permissions.ts`: only its top comment changed (a new permission also gets its line in `tests/permissions.test.ts`).
     Keep this site's file; copy the comment if it still has the template's.
   - `README.md`: if this site still has the template's, copy the template's "Setting up, step by step", "Staying up to
     date" and "Troubleshooting" parts. A site that rewrote it: leave it.
   **Coming from below 0.10.21** (lists in raw SQL). The upgrade brings the fix itself (`src/platform/db-socket.ts`) and its tests
   (`tests/db-socket.test.ts`, with the tests in step 3). In this site's own code: a route that reads a page of ids and then the
   rows for them becomes ONE statement (`database.md`, "Don't fetch ids, then fetch rows by those ids"); a helper of its own that
   builds an array literal (`pgArray`) still works and can stay.
   **Coming from below 0.10.22** (uploads go straight to storage). The upgrade brings `src/platform/files.ts` and
   `files-browser.ts` (managed). In this site's own code, for every page whose browser code calls `putFile()` (a page, or the
   portal page that hosts an upload screen): add `await allowFileUploads(Astro.csp, Astro.url);` to its frontmatter (import
   it from `src/platform/files`). Without it the browser blocks the upload. Then check each upload route still checks its own
   types and max size before `createUpload()` (`files.md`, "Your own limits"); a route that used `MAX_FILE_BYTES` as its limit
   now allows 5 GB: give it a limit of its own. And after `putFile()`, the browser code checks the complete call's answer.
9. Check it:
   ```bash
   npm install
   npx prisma generate
   npx prisma migrate deploy   # skip this line if DATABASE_URL isn't set in this editor: Publish applies migrations
   npm test
   npm run build
   ```
   `tests/upgrade.test.ts` fails with what's missing if a schema line was skipped.
10. In the Preview: open the admin with the shield in the bar, sign up as a normal user with the emailed code and check they get no admin, if this site has `/jobs/` and came from below 0.10.13, check it shows skeleton rows and then its jobs, and check the pages this site changed.
11. Commit, do the owner's task, and at the end tell them in plain words what changed, and that it goes live when they publish. Only say what changed for this site. If it has `/jobs/` and came from below 0.10.13: the jobs list now shows loading rows, and filters without reloading the page. If it came from below 0.10.15: new sign-ups confirm their email with a 6-digit code, and anyone whose email was never confirmed may need to choose a new password. If it was below 0.10.11, also:
   - Password sign-up and sign-in work now, and pages load faster.
   - After publishing, they open the admin once with **View as admin** in the dashboard. It's the only way in from now on.
   - Whoever was an owner in the site before is now a normal user, and admins stay. Team members get in by signing up on the app; the owner gives them a role under Users.

## If it can't finish
Stop before committing, restore with `git checkout .` and `git clean -fd` on what the upgrade added, do the owner's task, and tell them it didn't finish. The site keeps
working as it did. Then write the required version to `.platform/upgrade-failed` (git-ignored, so it survives the restore), so the next session doesn't spend the owner's AI plan on the same failure. A newer required version, or the owner asking, tries again. Never publish a half-done upgrade.
