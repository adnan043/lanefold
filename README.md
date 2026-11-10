# Lanefold

**Lanefold** is a kanban app with built-in chat, built on the EzyStudio Web App template (below).

- **What to build:** `docs/product/SPEC.md`; later decisions that win over it: `docs/product/HANDOFF.md`;
  look and feel: `docs/product/visual-identity.md`.
- **Where it lives:** the product is at `/app/*` (`src/app/`, host page `src/pages/app/[...path].astro`); its
  routes in `src/server/routes/`, workspace access in `src/server/workspaces.ts`, plan limits only in
  `src/server/entitlements.ts`.
- There is no job board: it was removed (migration `drop_job_board`).

AI agents: read `AGENTS.md` first. Where the files above conflict with it, `AGENTS.md` wins.

---

# Site — Astro app

A starter for a **website plus its own app**, built with [Astro](https://astro.build) on one
Cloudflare Worker:

- **pages**: a home page made of sections and an about page (prerendered), a **blog** written as
  Markdown files, and a **job board** with search and detail pages;
- **accounts of its own**: sign-up with an emailed code, sign-in, two-step sign-in, password reset,
  signed-in devices — scrypt passwords, short-lived signed tokens, rotating refresh tokens, rate limits;
- **roles and permissions**: owner, admin and member out of the box, custom roles, and admin screens
  for users, roles and an activity log;
- a **dashboard** at `/dashboard`: a React app ([TanStack Router](https://tanstack.com/router) and
  [Query](https://tanstack.com/query)) on its own UI kit (`src/portal/ui/`), light and dark;
- your own **backend** at `/site-api`: a [Hono](https://hono.dev) app every page and screen reads through;
- your own **database**: Postgres, through [Prisma ORM 7](https://www.prisma.io).

One project, one build, one deploy.

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Setting up, step by step](#setting-up-step-by-step)
  - [Get the code](#get-the-code) · [Install](#install) · [Settings (.env)](#settings-env) ·
    [The database](#the-database) · [Run it](#run-it)
- [Local development mode](#local-development-mode)
- [Create your admin account](#create-your-admin-account)
- [Scripts](#scripts)
- [Project structure](#project-structure)
- [Building on it](#building-on-it) (what not to edit, the database, sample data)
- [Tests](#tests)
- [Staying up to date](#staying-up-to-date)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [On the platform](#on-the-platform) (publishing, accounts, addresses)

## Quick start

With [Node.js 22.12+](#requirements) and Docker running:

```bash
git clone <the template repository's address> my-site
cd my-site
npm install
docker compose up -d --wait db      # a local Postgres (docker-compose.yml)
npm run setup                       # .env with a new JWT_SECRET, database check, tables
npm run dev                         # http://localhost:4321
```

Then [create your admin account](#create-your-admin-account): sign up at
http://localhost:4321/account/register/, type the code printed by `npm run dev`, and run
`npm run dev-admin -- you@example.com`.

## Requirements

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 22.12 or later (`.nvmrc` says 22: `nvm use`) | `node -v` |
| npm | the one that comes with Node.js | `npm -v` |
| Docker | any recent Docker Desktop or Engine with `docker compose` | `docker compose version` |
| git | any | `git --version` |

No Docker? Any Postgres 15 or later on your computer works: put its address in `DATABASE_URL`
([Settings](#settings-env)).

## Setting up, step by step

`npm run setup` does [Settings](#settings-env) and [The database](#the-database) for you (not the sample data); this is what it does, and how to do it by hand.

### Get the code

Clone the template repository, so later releases can be merged into your work
([Staying up to date](#staying-up-to-date)):

```bash
git clone <the template repository's address> my-site
cd my-site
git remote rename origin upstream             # the template: releases come from here
git remote add origin <your own repository's address>
git push -u origin main
```

Don't use a "Use this template" button or copy the files: that makes a copy with no shared
history, and `git merge` can no longer tell your changes from the template's. Already did? See
[Started from a copy](#started-from-a-copy).

### Install

```bash
npm install
```

### Settings (.env)

`npm run setup` makes `.env` from `.env.example`, generates a `JWT_SECRET` and points
`DATABASE_URL` at the local database. It never overwrites a value you set. By hand:
`cp .env.example .env` and fill in the two required values. `.env` stays on your computer (git
ignores it): never commit it. Restart `npm run dev` after changing it.

| Variable | On your computer | What it is |
| --- | --- | --- |
| `DATABASE_URL` | **required** | the Postgres connection string. Local: `postgresql://postgres:dev@localhost:5432/site`. |
| `JWT_SECRET` | **required**, 32+ random characters | signs sign-in tokens and keys the rate limits. Make one: `openssl rand -base64 48`. |
| `SITE_KEY` | **leave empty** | the secret the platform gives hosted sites to send account emails. Empty turns on [local development mode](#local-development-mode). |
| `SITE_URL` | leave empty | the site's address on the platform, where it answers `/api/*`. |
| `SITE_PREVIEW` | leave empty | `1` only in the platform editor's Preview. |
| `SITE_OWNER_ID` | leave empty | the platform's opaque id for the account's owner. |
| `DB_PORT` | optional | the port `docker-compose.yml` publishes when 5432 is taken ([Troubleshooting](#troubleshooting)). The site never reads it. |

### The database

`docker-compose.yml` runs Postgres 16 with a database named `site` (user `postgres`, password `dev`),
kept in a Docker volume between restarts:

```bash
docker compose up -d --wait db    # start (and wait until it is ready)
docker compose stop db            # stop, keeping the data
docker compose down -v            # delete it, data included: start from empty
```

Create the tables, and run it again after every new migration (yours or a template release's):

```bash
npm run db:migrate                # prisma migrate deploy
npm run db:seed                   # optional: the sample data in prisma/seed.sql
```

### Run it

```bash
npm run dev                       # http://localhost:4321
```

If `npm run dev` returns to the prompt with "Dev server running at…", it runs in the background:
`npx astro dev logs` shows its output, `npx astro dev stop` stops it.

## Local development mode

There is no `SITE_KEY` on your computer, so nothing can be emailed. While `npm run dev` runs with
an empty `SITE_KEY`, the site is in **local development mode**: every account email (sign-up and
sign-in codes, reset and confirmation links) is printed where `npm run dev` runs (or in
`npx astro dev logs`), under "LOCAL DEVELOPMENT ONLY", instead of being sent:

```
────────── LOCAL DEVELOPMENT ONLY: this email was not sent ──────────
  sign_up_code → you@example.com
  code: 123456
  link: http://localhost:4321/account/verify/?signup=…
```

It is off as soon as `SITE_KEY` or `SITE_PREVIEW` is set, with `NODE_ENV=production`, and in every
`npm run build` (the check is compiled out), so it is never on a hosted site.

## Create your admin account

On a hosted site the admin is the account's owner, who opens it with "View as admin" in the
dashboard. On your computer nobody can press that, so you make a local admin:

1. Open http://localhost:4321/account/register/ and sign up with any address (`you@example.com`)
   and a password of 10 or more characters.
2. Type the 6-digit code printed by `npm run dev` ([Local development mode](#local-development-mode)).
3. In another terminal, in the project folder:
   ```bash
   npm run dev-admin -- you@example.com
   ```
4. Open (or reload) http://localhost:4321/dashboard/: Users, Roles and Activity are there.

`dev-admin` changes your LOCAL database only. It refuses when `SITE_KEY` or `SITE_PREVIEW` is set or
`NODE_ENV=production`, and when `DATABASE_URL` isn't on this computer: its host must be
`localhost`, `*.localhost`, `127.x.x.x`, `::1` or a docker compose service name (one word, no dots).
It never makes an owner, so the few things only the owner can do (editing roles) can't be tried
locally.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | checks Node.js and packages, makes `.env` (new `JWT_SECRET`), checks the database, creates the tables |
| `npm run dev` | the dev server, http://localhost:4321 |
| `npm run build` | the production build into `dist/` (what the platform builds) |
| `npm test` | unit tests; integration tests too with `TEST_DATABASE_URL` ([Tests](#tests)) |
| `npm run check` | `npm test`, then `npm run build`: run it before you push |
| `npm run db:migrate` | applies new migrations (`prisma migrate deploy`) |
| `npm run db:seed` | loads `prisma/seed.sql` |
| `npm run dev-admin -- <email>` | a local admin ([Create your admin account](#create-your-admin-account)) |
| `npm run studio` | Prisma Studio on http://localhost:5555, to browse the database |
| `npm run preview` | serves the last `npm run build` |
| `npm run platform -- jobs` | checks `background.json` and its handlers |
| `npm run platform -- check` | the template's own files untouched, and is a newer release out ([Staying up to date](#staying-up-to-date)) |
| `npm run platform -- docs --site <a hosted site's address>` | the platform's latest rules for AI agents, into `.platform/docs/` |

## Project structure

```
AGENTS.md                rules for AI agents (CLAUDE.md, GEMINI.md import it)
docs/agent/              the rules by topic: auth, roles, security, performance, database, UI, SEO…
template.json            which template version this is
docker-compose.yml       the local Postgres
scripts/platform.mjs     setup, dev-admin, template updates, checks
prisma/                  schema.prisma, migrations/, seed.sql
tests/                   unit tests; tests/integration/ = the Site API on a real Postgres
public/                  files served as they are (_headers: security headers)
src/
  content/site.ts        navigation, home sections, about copy, the site's name and address
  content/blog/          blog posts (Markdown)
  assets/                images optimised at build
  pages/                 pages: index, about, blog/, jobs/, account/, portal/, site-api/, sitemap, RSS
  portal/                the dashboard (React): routes.tsx, screens/, ui/ (the UI kit)
  server/                YOUR backend: app.ts, routes/, auth-settings.ts, permissions.ts
  platform/              the template's managed core (auth, guards, platform calls): never edit
  lib/                   shared types, form rules, browser helpers, seo.ts
```

## Building on it

- **Your code**: `src/server/` (routes), `src/pages/` (pages), `src/portal/` (dashboard screens),
  `src/content/` (words), `src/lib/`, `src/styles/`, `prisma/`. `AGENTS.md` and `docs/agent/` have
  the rules for each: read them, or have your AI read them, before every change.
- **Never edit the template's own files**: `src/platform/`, `docs/agent/`, `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `template.json`, `CHANGELOG.md`, `scripts/platform.mjs` and `scripts/managed-files.json`.
  Releases replace them (that is how security fixes arrive). Each is compared byte for byte with the
  release `template.json` names: `npm run platform -- check` lists any that changed, and a store
  listing that changed or deleted one is refused. Put one back with
  `git checkout v<your version> -- <file>`. Extend them from your own code. `.gitattributes` keeps
  every text file LF, so a Windows checkout doesn't change them.
- **Changing the database**: a new migration for every change, never an edit to an applied one.
  ```bash
  npx prisma migrate dev --create-only --name add_bookings   # 1. write it
  # 2. wrap prisma/migrations/<…>/migration.sql in BEGIN; … COMMIT;
  npx prisma migrate dev                                      # 3. apply it
  npx prisma generate                                         # 4. the client gets the new model
  ```
  Change tables in steps (add, fill, switch, drop later): `docs/agent/database.md`.
- **Sample data, `prisma/seed.sql`**: made-up rows, never for a live database. Wrap it in
  `BEGIN;` … `COMMIT;`; start with a block that stops with `RAISE EXCEPTION` when real data is
  there; make it safe to run twice (`ON CONFLICT DO NOTHING` or `WHERE NOT EXISTS`); `@example.com`
  addresses, no users or passwords. The shipped one is the example to copy. A web app listed in a
  store must have one with sample data for ITS tables (at least one `INSERT`): the store loads it
  into its review copy and its preview, and into a customer's staging database only when they ask.
- **Before you push**: `npm run check` and `npm run platform -- check`. If this project has a
  `DEVELOPERS.md`, follow its "For your AI" steps (and its ready-to-submit checklist) too.

## Tests

```bash
npm test                          # unit tests
```

Integration tests run the real Site API on a real Postgres and **empty that database first**: give
them a database of their own, never the one you work in.

```bash
docker compose exec db createdb -U postgres site_test
DATABASE_URL=postgresql://postgres:dev@localhost:5432/site_test npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5432/site_test npm test
```

## Staying up to date

Template releases are tagged `vX.Y.Z` in the template repository you cloned from (`upstream`).
`CHANGELOG.md` says what each changed and whether it is required. With your work committed:

```bash
git fetch upstream --tags
git describe --tags --abbrev=0 upstream/main   # the newest release
git merge "$(git describe --tags --abbrev=0 upstream/main)"
npm install
npm run db:migrate
npm run check
```

Then follow the new `docs/agent/upgrade.md` for anything that release asks of files you changed.

**Conflicts** (git lists them; search for `<<<<<<<`):
- `package-lock.json`: `git checkout --theirs package-lock.json`, then `npm install` (it rebuilds the
  lock for the merged `package.json`), then commit.
- The template's own files (`src/platform/`, `docs/agent/`, `scripts/`, `template.json`,
  `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`): take the template's
  (`git checkout --theirs <file>`). Never keep changes of your own in them: describe your project in `README.md` instead.
- Your files (pages, `src/content/site.ts`, styles): keep your words and look, and bring over what
  the template changed.
- `git merge --abort` puts everything back as it was.

### Started from a copy

No shared history with the template: connect it once, then merge releases as above.

```bash
git remote add upstream <the template repository's address>
git fetch upstream --tags
git merge v<the version in your template.json> --allow-unrelated-histories   # once
git merge "$(git describe --tags --abbrev=0 upstream/main)"                # then the newest release
```

The first merge lists every file that differs from that release (usually only the ones you
changed): keep your side of your own files (`git checkout --ours <file>`) and the template's side
of its own files (`git checkout --theirs <file>`), then commit.

## Troubleshooting

| What you see | Why | Fix |
| --- | --- | --- |
| `npm install` warns `EBADENGINE`, or `npm run setup` says Node.js is too old | Node.js below 22.12 | `nvm install 22`, then `nvm use 22` (or install 22.12+), then `npm install` again |
| `docker compose up` says `Bind for 0.0.0.0:5432 failed: port is already allocated` | another Postgres already uses port 5432 | put `DB_PORT=5433` in `.env` (and `:5433` in `DATABASE_URL` if it is already set), then `docker compose up -d --wait db` and `npm run setup` |
| `npm run setup` says `no database answers at localhost:5432` (or `ECONNREFUSED`) | the database isn't running, or Docker isn't | start Docker, then `docker compose up -d --wait db`, then `npm run setup` |
| sign-up answers 503 `auth_not_configured`: "Sign-in is not set up on this site yet" | `JWT_SECRET` is missing or shorter than 32 characters | `npm run setup` (or `openssl rand -base64 48` into `.env`), then restart `npm run dev` |
| pages or sign-in answer 503 `site_database_disabled` | `DATABASE_URL` is empty | `npm run setup`, then restart `npm run dev` |
| sign-up answers 500, and the dev server shows `relation "login_attempts" does not exist` or `The table public.permissions does not exist` | the tables aren't created (migrations pending) | `npm run db:migrate` |
| no code appears after signing up | `SITE_KEY` is set (codes are then emailed by the platform), or the dev server runs in the background | empty `SITE_KEY` in `.env` and restart; or read `npx astro dev logs` |
| no new code when you sign up again with the same address | account emails to one address are limited, so a repeat within a few minutes sends none | use the code printed the first time (it stays valid for a while), wait a few minutes, or sign up with another address |
| `dev-admin` says `no account for …` | that address hasn't finished signing up in this database | sign up and type the code first |
| `dev-admin` says `refused (local development only)` | `SITE_KEY`, `SITE_PREVIEW` or `NODE_ENV=production` is set, or `DATABASE_URL` isn't on this computer | empty them in `.env` (it only ever changes a local database) |
| `npm run dev` says port 4321 is in use, or opens another port | another dev server is running | use the address it prints, or stop the other one (`npx astro dev stop`) |
| http://localhost:4321 shows a different project, or sign-up says "This form has expired" | another app already listens on 127.0.0.1:4321, so this one only got the IPv6 address (`[::1]:4321`) and your browser reaches the other app | stop the other app, or run this one on a free port: `npx astro dev stop && npx astro dev --port 4322` |
| the dashboard shows nothing for admins after `dev-admin` | the page was open before | reload `/dashboard/` |

## FAQ

**Can I be the owner on my computer?** No. The owner is only ever the account's owner on the
platform, through "View as admin". Locally you are an admin, which covers everything but editing
roles.

**Do I need a Site Key?** No. Without one the site runs in local development mode. Never copy a
hosted site's Site Key to your computer.

**Can I use another database?** Postgres only (any Postgres 15+). `DATABASE_URL` takes any
Postgres connection string.

**Where do emails go on my computer?** Nowhere: they are printed where `npm run dev` runs.

**How do I start over?** `docker compose down -v`, `docker compose up -d --wait db`,
`npm run setup`.

**Can I deploy it somewhere else?** It is built to run on the platform it came from (one Worker,
its database, its emails); there is no other deploy config.

---

## On the platform

### Put it live

Pick **Astro app** when you create a site in the dashboard (or turn on "make it an app"), change what
you like in the editor (or ask your AI agent), then **Publish**.

**Enable the Site Database first.** This project ships migrations; a version with migrations is
refused until the site has a database. Only your account's owner can open the admin, with **View as
admin** in the dashboard. Anyone who signs up is a normal user, whatever email they use.

The platform sees `astro` and `@astrojs/cloudflare`, installs with `npm ci`, runs
`npm run build` (`prisma generate && astro build`), applies new migrations to your live database,
then deploys. If a migration fails, the previous version keeps serving.

### Accounts

- The **owner** is your account's owner, who opens the admin with **View as admin** in the dashboard or the
  editor. There's no owner sign-up, password or owner list. Owners and admins manage users at `/dashboard/users` and roles at `/dashboard/roles`.
- Confirmation and password-reset emails are sent by the platform on your site's behalf.
- Change how sign-up works in `src/server/auth-settings.ts`.

### Write a post

Add a Markdown file to `src/content/blog/` (`my-post.md` → `/blog/my-post/`) with a `title`,
`description` and `publishedAt` at the top (see `how-to-add-a-post.md` there), then Publish.

### What this site controls

| Address | Served by |
| --- | --- |
| `/`, `/about/`, `/blog/`, `/jobs/` | this site |
| `/sitemap.xml`, `/robots.txt`, `/rss.xml` | this site (search engines, feed readers) |
| `/account/login`, `/account/register`, `/account/forgot`, … | this site (sign-in) |
| `/dashboard/…` | this site (the dashboard) |
| `/site-api/…` | this site (your API) |
| `/api/…` | the platform |
