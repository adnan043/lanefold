# EzyStudio Web App template — developer guide

This repository is the **Web App template** (`astro-app`) that every EzyStudio app site starts
from: Astro and a Hono backend on one Cloudflare Worker, its own sign-in and roles, a React
dashboard and a Postgres database. It is published for developers who build **web app listings
for the [EzyStudio App Store](https://ezystudio.com/app-store)** on their own computer. You build a
whole site on this template, submit it, and every customer who installs it gets a new site made
from your code.

This repository is the ONLY place to get the template: there is no download. Clone it, and take
every release with `git merge`.

Files for you, the developer (submit leaves all four out, so they never reach a customer's site):
- `DEVELOPERS.md` (this guide) and `LICENSE`.
- `STORE-LISTING.md`: every store rule for a whole site, in plain words: sample data, review, your
  preview, paid listings, updates.
- `store-check.mjs`: the store's checks for this release, on your machine: `node store-check.mjs`.

`README.md` is the template's own setup guide (it ships into every site, so it never names us);
`AGENTS.md` and `docs/agent/` are the rules for the AI that works on the site, yours first, then the
customer's.

**License:** this template belongs to EzyStudio and is **not open source** ([`LICENSE`](LICENSE)).
You may use and change it only to build sites and apps that run on EzyStudio. Using it, or anything
made from it, anywhere else (other hosting, other products, other templates) is not allowed. The code
you write yourself stays yours.

## Contents

1. [Quick start](#1-quick-start)
2. [Clone and remotes](#2-clone-and-remotes)
3. [Your admin account](#3-your-admin-account)
4. [Build your app](#4-build-your-app)
5. [Sample data](#5-sample-data)
6. [The template's own files](#6-the-templates-own-files)
7. [Check it like submit does](#7-check-it-like-submit-does)
8. [Submit](#8-submit)
9. [What review checks](#9-what-review-checks)
10. [Your public preview](#10-your-public-preview)
11. [How updates work](#11-how-updates-work)
12. [Troubleshooting](#12-troubleshooting)
13. [FAQ](#13-faq)
14. [For your AI](#14-for-your-ai)
15. [Reporting problems and suggesting changes](#15-reporting-problems-and-suggesting-changes)

Links: [developer docs](https://ezystudio.com/developers/docs) ·
[developer program](https://ezystudio.com/developers) ·
[developer portal](https://ezystudio.com/dev) ·
[the Website template](https://github.com/EzyStudio/website-template) (static sites)

## 1. Quick start

You need Node.js 22.12+, npm, git and Docker.

```bash
git clone https://github.com/EzyStudio/web-app-template.git my-app
cd my-app
git remote rename origin upstream
npm install
docker compose up -d --wait db
npm run setup
npm run db:seed                               # the sample data
npm run dev                                   # http://localhost:4321
```

Sign up at http://localhost:4321/account/register/, type the code printed by `npm run dev`, then
`npm run dev-admin -- you@example.com` and open http://localhost:4321/dashboard/.
Every step in detail: `README.md`.

## 2. Clone and remotes

```bash
git clone https://github.com/EzyStudio/web-app-template.git my-app
cd my-app
git remote rename origin upstream             # the template: releases come from here
git remote add origin git@github.com:<you>/<your-repo>.git
git push -u origin main
```

- **Clone; don't press "Use this template" and don't copy the files.** A clone keeps the template's
  history, so each release merges into your work with one `git merge` ([How updates work](#11-how-updates-work)).
- **Watch releases:** on https://github.com/EzyStudio/web-app-template press **Watch → Custom →
  Releases**. Each release notes what changed and whether it is required. Every submission, a
  first version and every update, must be on the template's CURRENT release.
- Keep `upstream`: `node store-check.mjs` and `npm run platform -- check` read its release tags.

## 3. Your admin account

There is no Site Key on your computer, so the site runs in **local development mode**: account
emails (sign-up codes, reset links) are printed where `npm run dev` runs instead of being sent.

1. Sign up at http://localhost:4321/account/register/ and type the 6-digit code from the terminal
   (`npx astro dev logs` when the dev server runs in the background).
2. `npm run dev-admin -- you@example.com` makes that account an admin in your LOCAL database.
3. Open http://localhost:4321/dashboard/.

Nothing makes you the owner locally: on a customer's site the owner is the customer, through "View
as admin". Owner-only actions (editing roles) can't be tried locally.

## 4. Build your app

- Read `AGENTS.md` and `docs/agent/` first, and have your AI read them before every task.
- Your code: `src/server/`, `src/pages/`, `src/portal/`, `src/content/`, `src/lib/`, `src/styles/`,
  `prisma/`. Never the template's own files ([section 6](#6-the-templates-own-files)).
- Describe your app in `README.md`: what it does, where each feature lives, what an owner usually
  changes. The customer's AI reads it.
- Migrations only add (tables, nullable columns, indexes); never edit a released one.
- A new permission is one entry in `CATALOGUE` (`src/server/permissions.ts`) plus its lines in
  `tests/permissions.test.ts`, which lists every codename and ability on purpose: `npm test` fails
  until both are there (`docs/agent/roles-and-permissions.md` "Recipe: add a permission").
- Postgres only, no secrets in any file, no install scripts, no deploy config.
- Rules in full: `STORE-LISTING.md`, and
  [Building an app](https://ezystudio.com/developers/docs/building-apps),
  [Security rules](https://ezystudio.com/developers/docs/security),
  [Database](https://ezystudio.com/developers/docs/database),
  [Best practices](https://ezystudio.com/developers/docs/best-practices).

## 5. Sample data

**Required.** A web app listing must ship `prisma/seed.sql` with sample data for its own tables:
the review test site and your public preview must show a working app. Submit refuses a web app
without one, or with only comments (`seed_missing`), and one with no `INSERT` at all (`seed_empty`).

- **What to put in:** a few rows of each thing your app shows (products, bookings, posts…), enough
  that every screen has something on it. Your migrations create the tables; they never insert demo
  rows: sample data lives only here.
- **Replace the template's.** The shipped seed is the template's job board example (three sample
  jobs). Keep it only if your app still has that job board; `node store-check.mjs` notes it while it
  is unchanged, and it fails at review if your schema has no `jobs` table.
- **The rules** (the review refuses a seed that breaks them, and the loaders refuse to run it):
  - Wrap it in `BEGIN;` … `COMMIT;`: all or nothing.
  - Refuse a database in use: start with a `DO $$ … $$` block that stops with `RAISE EXCEPTION`
    when real data is there (rows that aren't yours). The template's seed shows how.
  - No users and no passwords: people sign up. Made-up people only, `@example.com` addresses.
  - Safe to run twice: explicit keys with `ON CONFLICT DO NOTHING`, or `WHERE NOT EXISTS (…)`.
  - Only your tables. No roles, rights, functions, triggers, extensions, `COPY` or `EXECUTE`.
- **Where it loads:** the review test site, your public preview (again on "Load sample data again"),
  and a customer's **staging** database only when they press "Load sample data". Never a live
  database.
- **Try it:** `npm run db:seed` twice in a row on your local database; both must pass.
- When you change the schema, update the seed in the same commit.

[Sample data rules](https://ezystudio.com/developers/docs/database#seed).

## 6. The template's own files

These are the template's, and every release replaces them. Never change, add to or delete them:

| Group | Files | Refused at submit as |
| --- | --- | --- |
| The managed core | `src/platform/` (nothing changed, added or deleted) | `platform_changed` |
| Instructions for the customer's AI | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/agent/` | `instructions_changed` |
| The template's own files | `template.json`, `CHANGELOG.md`, `scripts/platform.mjs`, `scripts/managed-files.json` | `managed_file_changed` |

Submit compares each byte for byte with the release your `template.json` names. Put them back with
git, from the tag of the release you are on (`v` + the version in `template.json`, such as `v1.4.2`).
`npm run platform -- check` and `node store-check.mjs` print this command with your tag filled in:

```bash
git checkout v<the version in template.json> -- src/platform docs/agent AGENTS.md CLAUDE.md GEMINI.md template.json CHANGELOG.md scripts/platform.mjs scripts/managed-files.json
```

A file you added under `src/platform/` or `docs/agent/`: move your code out, then `git rm` it.
Line endings count: the template's `.gitattributes` keeps every text file LF, also on Windows. A
copy that turned them into CRLF anyway: `git add --renormalize .`, then commit.

## 7. Check it like submit does

`store-check.mjs` and `STORE-LISTING.md` are in this repository and every release brings their new
copies. From the top of your repository:

```bash
node store-check.mjs                          # the same checks as submit
npm run platform -- check                     # the template's own files, sample data, a newer release
npm run check                                 # tests and the production build
```

`node store-check.mjs` fails when your template is behind the current release ("Your template is
<yours>; the current one is <newest>. Merge it before you submit."), when one of the template's own
files changed, and when the sample data is missing. Offline, the release check is a note.

## 8. Submit

1. **Join the developer program** at https://ezystudio.com/developers. Once approved, your team
   works in the [developer portal](https://ezystudio.com/dev).
2. Push your branch to GitHub.
3. Open [Submit an app](https://ezystudio.com/dev/submit): name, category, description and data
   note; screenshots and icon; under **App code**, connect GitHub and pick the repository and
   branch. The checks run on its latest commit at once and show the first problem with its file;
   after a push, press **Check again**.
4. Pricing: free, one-time or monthly (you keep 80%).
5. Send it for review. Before Submit the portal checks the branch's latest commit again: while the
   template is behind, one of its files changed or the sample data is missing, **Submit stays off**
   and says what to run. Submitting freezes that commit.

[Submitting](https://ezystudio.com/developers/docs/submitting) has the details.

## 9. What review checks

Levels, one after another, each with the file and the fix when it fails:
package rules (the current template release, the template's own files untouched, sample data) →
security (secrets, code that reads sign-ins or keys, vulnerable packages, install scripts, outside
payments, other databases) → build (a real test site with your migrations and sample data) →
performance → UI and accessibility → data and privacy → an AI-assisted code review → a human
reviewer who opens the test site. [Review](https://ezystudio.com/developers/docs/review).

## 10. Your public preview

Once approved, the store hosts a preview of your app built from the approved code, with its own
database and your sample data, so people can try it before installing. In the developer portal:
- **Get admin login** emails each person on your team an admin login for the preview (never owner).
- **Load sample data again** empties the preview and loads your seed again.

## 11. How updates work

Two kinds of update meet in your repository:

- **Template releases** (from `upstream`): tagged `vX.Y.Z`, with release notes. Merge each one:
  ```bash
  git status                                  # clean: commit your work first
  git fetch upstream --tags
  git describe --tags --abbrev=0 upstream/main   # the newest release
  git merge "$(git describe --tags --abbrev=0 upstream/main)"
  npm install
  npm run db:migrate
  npm run check
  node store-check.mjs
  ```
  Git merges line by line: a file only the template changed takes its version, a file only you
  changed keeps yours, and a place you both changed is a conflict to solve:
  - `package-lock.json`: `git checkout --theirs package-lock.json`, then `npm install`, then commit.
  - The template's own files ([section 6](#6-the-templates-own-files)) and `DEVELOPERS.md`,
    `LICENSE`, `STORE-LISTING.md`, `store-check.mjs`: `git checkout --theirs <file>`.
  - `prisma/seed.sql` and your other files: keep your work, bring over what the template changed.
  - `git merge --abort` puts everything back.

  Then follow the release's `docs/agent/upgrade.md` for anything it asks of files you changed, run
  `node store-check.mjs` (the merge brought its new copy), push, and submit an update.
- **Your app's updates** (to customers): every new version you submit goes through review and must
  be on the current template release too; once approved, customers see "Update available", and it
  is merged into their copy (their changes stay; clashes go to their AI). Keep updates small, don't
  move files without reason, and only add migrations. Tag your own versions with a prefix of your
  own (`app-v1.2.0`), never `v1.2.0`: the `v*` tags are the template's releases.
  [Updates](https://ezystudio.com/developers/docs/updates).

## 12. Troubleshooting

`README.md` › Troubleshooting covers setup (Node version, port 5432 taken, database not running,
503 `auth_not_configured` without `JWT_SECRET`, pending migrations). For the store:

| What you see | Fix |
| --- | --- |
| `template_outdated`, or "Your template is … the current one is …" | `git fetch upstream --tags`, then `git merge "$(git describe --tags --abbrev=0 upstream/main)"`, then `npm install`, `npm run db:migrate`, `npm run check`, `node store-check.mjs` |
| `platform_changed`, `instructions_changed` or `managed_file_changed` | `git checkout v<the version in template.json> -- <the files it names>`, then commit ([section 6](#6-the-templates-own-files)) |
| `seed_missing` or `seed_empty` | write `prisma/seed.sql` ([Sample data](#5-sample-data)) |
| "Windows line endings (CRLF)" | `git add --renormalize .`, then commit |
| `store-check.mjs` fails on `.claude/` or `.vscode/` | `git rm -r --cached .claude .vscode` and add them to `.gitignore` |
| `git merge` refuses: "untracked working tree files would be overwritten" (`store-check.mjs`, `STORE-LISTING.md`) | you copied them in from an old download: delete them (and their `.gitignore` lines), then merge again |

## 13. FAQ

**Do I need a Site Key or an EzyStudio account to build?** No: everything runs locally. You need
an approved developer account only to submit.

**I started from a zip of an older template.** There is no zip any more. Clone this repository
fresh and copy your own files in (never the template's own files), or connect your copy once:
`git remote add upstream https://github.com/EzyStudio/web-app-template.git`, `git fetch upstream --tags`,
`git merge v<your template.json version> --allow-unrelated-histories` (keep your side of your files,
`--theirs` for the template's), then merge the newest release as usual.

**Can I test the owner's "View as admin"?** Not locally. On your public preview, "Get admin login"
gives your team admin accounts.

**Where do my own docs go?** `README.md`. Never a second `AGENTS.md` or another AI instruction file:
submit refuses them.

**Can I host the app elsewhere?** No: the license allows building sites and apps that run on
EzyStudio.

## 14. For your AI

Exact steps for a coding agent with only this repository. Run each command from the repository
root; stop and report if one fails. Never skip a step to make a check pass.

1. **Every task:** read `AGENTS.md`, then the `docs/agent/` topic for the work, then
   `STORE-LISTING.md` once per session.
2. **Set up** (once):
   1. `node -v` must be 22.12 or later; otherwise tell the developer to install it (`.nvmrc`).
   2. `git remote -v` must list `upstream` (this template's repository). A fresh clone lists it as
      `origin` instead: `git remote rename origin upstream` (the developer adds their own `origin`
      later). No remote for this template at all: `git remote add upstream https://github.com/EzyStudio/web-app-template.git`.
   3. `npm install`
   4. `docker compose up -d --wait db` (if port 5432 is taken: add `DB_PORT=5433`, or another free
      port, to `.env` and run it again; `npm run setup` then uses that port).
   5. `npm run setup` — it fills in `.env` (a new `JWT_SECRET` and the local `DATABASE_URL`;
      `SITE_KEY` stays empty or absent) and runs the migrations. Never put a real `SITE_KEY` in `.env`.
   6. `npm run db:seed` loads the sample data.
3. **Run it and create the local admin:**
   1. `npm run dev`. Open http://localhost:4321 (or the address it prints).
   2. Sign up at `/account/register/` with the developer's address (in the browser, or ask the
      developer to).
   3. The 6-digit code is in the dev server's output under "LOCAL DEVELOPMENT ONLY"
      (`npx astro dev logs` if it runs in the background). Type it on the verify page.
   4. `npm run dev-admin -- <that address>`; reload `/dashboard/`.
   Never give anyone `owner`, never write roles into the database yourself, never set `SITE_KEY`
   or `NODE_ENV=production` to get around a refusal.
4. **Build the app** in the developer's own files only (`src/server/`, `src/pages/`, `src/portal/`,
   `src/content/`, `src/lib/`, `src/styles/`, `prisma/`), by `AGENTS.md` and `docs/agent/`. Every
   schema change: a new migration (`docs/agent/database.md`), never an edit to a released one.
   Describe the app in `README.md`.
5. **Sample data** (required): write or update `prisma/seed.sql` for the app's own tables, by
   [Sample data](#5-sample-data): `BEGIN;` … `COMMIT;`, a `DO $$ … RAISE EXCEPTION … $$` block that
   refuses a database in use, no users or passwords, `@example.com` only, safe twice (`ON CONFLICT DO
   NOTHING`). Replace the template's job rows unless the app keeps the job board. Run
   `npm run db:seed` twice; both must pass.
6. **Never touch the template's own files**: `src/platform/`, `docs/agent/`, `AGENTS.md`,
   `CLAUDE.md`, `GEMINI.md`, `template.json`, `CHANGELOG.md`, `scripts/platform.mjs`,
   `scripts/managed-files.json` (and `DEVELOPERS.md`, `LICENSE`, `STORE-LISTING.md`,
   `store-check.mjs`). If one changed: `git checkout v<version in template.json> -- <file>`.
7. **Keep the template current:**
   1. `git fetch upstream --tags`, then `git describe --tags --abbrev=0 upstream/main` is the newest
      release: compare it with `version` in `template.json`.
   2. Newer one out: `git status` must be clean (commit first), then
      `git merge "$(git describe --tags --abbrev=0 upstream/main)"`.
   3. Resolve: `package-lock.json` → `git checkout --theirs package-lock.json`, then `npm install`;
      the files in step 6 → `git checkout --theirs <file>`; the developer's files and
      `prisma/seed.sql` → keep theirs and bring over the template's change.
   4. `npm install`, `npm run db:migrate`, then the release's `docs/agent/upgrade.md`, from its step 2.
   5. If it can't finish: `git merge --abort`, and say so.
8. **Check, and fix every failure** (then run them again until all pass):
   1. `npm run check` (tests and the production build).
   2. `npm run platform -- check` (the template's own files, sample data, a newer release).
   3. `node store-check.mjs` (the store's checks: every line must be PASS or NOTE).
9. **Ready to submit?** Only when every box is true, report this list to the developer with each box
   ticked, and anything you could not do:
   - [ ] `template.json` is the newest release (`git describe --tags --abbrev=0 upstream/main`).
   - [ ] `git status` is clean; no merge in progress, no conflict markers (`git grep -nE '^(<{7}|>{7}) '` finds nothing).
   - [ ] The template's own files (step 6) are untouched: `npm run platform -- check` says so.
   - [ ] `prisma/seed.sql` is this app's sample data and `npm run db:seed` passes twice.
   - [ ] `npm run check` passes.
   - [ ] `node store-check.mjs` passes (no FAIL).
   - [ ] Sign-up, sign-in and the app's admin screens work locally.
   - [ ] `README.md` describes the app for its owner and their AI.
   - [ ] No keys, passwords or real people anywhere in the repository.
   Then the developer pushes and submits in the developer portal.

## 15. Reporting problems and suggesting changes

This repository is where releases are published; it is read-only for everyone outside the team.

- **Nobody pushes to `main`.** `main` and the `v*` release tags are protected: they change only
  with a release. Work in your own repository (`origin`), never in this one.
- **Found a bug, or something unclear?** Open an issue here, with the template version
  (`template.json`), what you did and what you saw. Never paste a `.env`, a key or customer data.
- **Want to suggest a change?** Fork this repository and open a pull request against `main`. We
  review it, and when we take it, the change goes out in the next release (the pull request is then
  closed with "Included in vX.Y.Z"). Pull requests are not merged here directly, because every
  release replaces these files from our own source.
- **Security problem?** Don't open a public issue: email support@ezystudio.com with "Security" in the subject.
