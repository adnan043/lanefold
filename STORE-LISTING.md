# Store listing: a whole web app

This repository is the Web App template (`astro-app`), release 0.10.22: exactly what every new
site starts from, plus four files for you, the developer:
- `DEVELOPERS.md`: setting up, your admin account, updates by `git merge`, and steps for your AI.
- `STORE-LISTING.md` (this file): what the store needs from a whole-site listing, and how review works.
- `store-check.mjs`: the store's checks for release 0.10.22, run on your machine with `node store-check.mjs`.
- `LICENSE`: what you may do with the template.

Keep them committed: each release updates them when you merge it. Submit leaves all four out, so they
never go into a customer's site. When you work with an AI, ask it to read this file, `DEVELOPERS.md`
and `AGENTS.md` before each task.

### The `{{…}}` placeholders
`AGENTS.md` and `docs/agent/` name a few things as double braces around a name. The platform fills
them in the editor; this repository keeps them as written, because submit compares those files byte for byte:
never fill them in yourself, and never let your AI open one as a URL or path. What each means, and what it is
on your machine:
- `{{API_PREFIX}}`: the platform's own paths on every site's address (`/api`). On your machine: nothing answers there.
- `{{SITE_API_PREFIX}}`: what the site's server calls with its Site Key (`/api/site/v1`). On your machine: not reachable without a Site Key.
- `{{PUBLIC_SITE_API_PREFIX}}`: public platform answers, with no key (`/api/public/site/v1`). On your machine: not reachable.
- `{{DOCS_URL}}`: the current rules, on a hosted site's address (`/api/public/site/v1/agent-docs`). On your machine: `docs/agent/` in this folder (or `npm run platform -- docs --site <a hosted site>`).
- `{{DOCS_DIR}}`: the current rules folder, in the editor. On your machine: `docs/agent/` in this folder.
- `{{TEMPLATE_ZIP}}`: the copy of the newest template the platform provides in the editor. On your machine: the newest release tag of this repository (`git fetch upstream --tags`, then `git merge` it: DEVELOPERS.md).
- `{{LIVE_MIGRATIONS_FILE}}`: which migrations the live database has, in the editor. On your machine: `npx prisma migrate status` on your own database.
- `{{SITE_URL_ENV}}`: the variable holding the site's own address (`SITE_URL`). On your machine: leave it empty.
- `{{SITE_KEY_ENV}}`: the variable holding the Site Key, a secret (`SITE_KEY`). On your machine: leave it empty: local development mode is on without it.
- `{{SITE_KEY_PREFIX}}`: how a Site Key starts (`stk_`). On your machine: there is none.
- `{{SITE_ORIGIN_PATTERN}}`: a site's free address on the platform. On your machine: http://localhost:4321.
- `{{EMAIL_ENDPOINT}}`: where account emails are relayed (`/api/site/v1/emails`). On your machine: printed in the `npm run dev` terminal instead.
- `{{EMAIL_KINDS}}`: the account email kinds (`password_reset`, `verify_email`, `password_changed`, `account_exists`, `confirm_email_change`, `email_changed`, `sign_in_code`, `sign_up_code`, `email_change_requested`, `two_factor_on`, `two_factor_off`, `recovery_codes_new`). On your machine: the same.
- `{{EMAIL_PATH_MAX}}`: the longest link path an email may carry (`512`). On your machine: the same.
- `{{EMAIL_EXPIRES_MAX_MINUTES}}`: the longest life of a link in an email, in minutes (`10080`). On your machine: the same.
- `{{EMAIL_SITE_HOURLY_LIMIT}}`: account emails a site may send an hour (`120`). On your machine: no limit (nothing is sent).
- `{{EMAIL_SITE_DAILY_LIMIT}}`: account emails a site may send a day (`1000`). On your machine: no limit (nothing is sent).
- `{{EMAIL_RECIPIENT_HOURLY_LIMIT}}`: account emails one address may get an hour (`5`). On your machine: no limit (nothing is sent).

## 1. What you are building
A store listing can be a whole site. A customer who installs it gets a NEW site made from your code, and
from then on it is theirs: they and their AI change it in the editor like any other site.
- **Web app** (the Web App template, `astro-app`): a server, logins and roles, and a Postgres
  database. The customer's site gets two databases, live and staging; your migrations run on both.
- **Static site** (the Website template, `astro-static`): every page prerendered, no database.
- Mobile apps are coming later.
- An add-on (a feature added to a site the customer already has, such as bookings) is a different kind
  of listing, not built in this repository.

This repository is for a **web app**.

## 2. Start
1. Clone this repository, keep it as `upstream`, and push to a new GitHub repository of your own
   (`DEVELOPERS.md` "Clone and remotes"), with `template.json` at its top level. Never copy the files
   without the history: every release reaches you by `git merge`. Watch the repository's releases.
2. Read `AGENTS.md` and `docs/agent/`: the template's own rules (database, security,
   performance, screens). They apply to your site and to the customer's AI after them.
3. With Node.js 22.12+ and Docker running (README.md "Quick start" has every step and "Troubleshooting" the
   usual errors):
   `npm install`, then `docker compose up -d --wait db` (a local Postgres, from `docker-compose.yml`),
   then `npm run setup`: it makes `.env` from `.env.example` with a new `JWT_SECRET` (sign-in
   answers 503 without one of 32 characters or more) and the local `DATABASE_URL`, leaves `SITE_KEY` empty,
   checks the database and runs the migrations. Then `npm run dev`, and open http://localhost:4321.
4. Sign in on your machine. With no `SITE_KEY`, `npm run dev` is in **local development mode**: sign up at
   `/account/register/`, and the code (and any reset link) prints in the `npm run dev` terminal (or
   `npx astro dev logs` when it runs in the background) under "LOCAL DEVELOPMENT ONLY" instead of being
   emailed. Then `npm run dev-admin -- you@example.com` gives that user the `admin` role in
   your LOCAL database; open (or reload) `/dashboard`.
   - It is off whenever a Site Key or `SITE_PREVIEW` is set, with `NODE_ENV=production` and in every
     `npm run build`, so it is never on a hosted site.
   - `dev-admin` refuses a `DATABASE_URL` whose host isn't this computer (`localhost`,
     `*.localhost`, `127.x.x.x`, `::1`) or a docker compose service name (one word, no dots).
   - Neither ever makes an `owner`: on a hosted site the owner is the customer, through "View as admin". So the
     few things only the owner can do (editing roles) can't be tried locally.
   - `npm run db:seed` loads `prisma/seed.sql` into your local database (write your own: section 6).

## 3. The rules
Submit refuses a version on the first one it breaks, and says which file and how to fix it.
`node store-check.mjs` runs the same checks before you push.
- **`template.json`** stays as the template wrote it (version `0.10.22` in this release).
  The version must be the template's CURRENT release on the day you submit, for a first version and for every
  update: older is refused, and so is any version that isn't a release. When a newer one comes out, merge it:
  `git fetch upstream --tags`, then `git merge "$(git describe --tags --abbrev=0 upstream/main)"`
  (a conflict in `package-lock.json`: `git checkout --theirs package-lock.json`, then `npm install`),
  then `npm install`, `npm run check` and `node store-check.mjs` (the merge brings its new copy). Follow the new release's `docs/agent/upgrade.md`
  for the steps a merge leaves to you. (`bad_template`, `template_outdated`)
- **`src/platform/` untouched.** It is the template's managed core (49 files): nothing
  changed, added or deleted. The checks compare every byte with this release's copy. Your code goes in
  `src/server/`, `src/lib/`, your pages and components. (`platform_changed`)
- **The template's own files untouched:** `template.json`, `CHANGELOG.md`, `scripts/platform.mjs`, `scripts/managed-files.json`. Byte for byte this release's copies,
  none deleted. (`managed_file_changed`)
- **Put any of them back** with git, from the release tag you are on:
  `git checkout v0.10.22 -- src/platform docs/agent AGENTS.md CLAUDE.md GEMINI.md template.json CHANGELOG.md scripts/platform.mjs scripts/managed-files.json`
  Line endings count: the template's `.gitattributes` keeps every text file LF, also on Windows.
- **Instructions for the customer's AI untouched.** Keep `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `docs/agent/`
  as the template has them: they are the template's instructions for the AI that works on the customer's site
  after you, byte for byte, nothing added or deleted. Add no other instruction files (a nested `AGENTS.md`,
  `.cursorrules`, `copilot-instructions.md`…). Describe your app in `README.md`.
  (`instructions_changed`)
- **`package.json`** has a `build` script and no `preinstall`, `install`, `postinstall`, `preprepare`, `prepare`, `postprepare`, `prepublish`, `dependencies` script: npm
  would run it on install in every customer's editor. (`bad_package`)
- **Postgres only.** No package for another database or data store: `mysql`, `mysql2`, `mariadb`, `@planetscale/database`, `mongodb`, `mongoose`, `sqlite`, `sqlite3`, `better-sqlite3`, `@libsql/client`, `libsql`, `redis`, `ioredis`, `@upstash/redis`, `firebase`, `firebase-admin`, `@firebase/firestore`, `@supabase/supabase-js`, `faunadb`, `fauna`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `dynamoose`, `couchbase`, `nano`, `pouchdb`, `cassandra-driver`, `neo4j-driver`, `@prisma/adapter-planetscale`, `@prisma/adapter-libsql`, `@prisma/adapter-d1`.
  (`not_postgres`)
- **Hidden files**: only `.gitignore`, `.gitattributes`, `.env.example`, `.editorconfig`, `.nvmrc`, `.node-version`, `.prettierrc`, `.prettierrc.json`, `.prettierignore`. So never commit `.claude/`, `.cursor/`, `.vscode/`, `.codex/`, `.idea/`, `.npmrc`,
  `.env` or `.platform/`: agent and editor settings can run commands for whoever opens
  the repository, `.env` holds your keys, and `.platform/` is the platform's own. If git
  already tracks one: `git rm -r --cached .claude`. (`hidden`)
- **No deploy config** (`wrangler.*`, `Dockerfile`, `Makefile`, `vercel.json`,
  `netlify.toml`): the platform deploys every site itself. **No shell scripts or native programs**
  (`.sh`, `.exe`, `.node`…): write scripts in JavaScript, `scripts/*.mjs`.
  (`forbidden_file`)
- **No secrets** in any file: no private keys, live payment keys, cloud keys or tokens, not even in a
  comment. Keys are settings the site owner enters. (`secret`)
- **Never touch the sign-ins and keys of whoever runs the code.** Your app runs in the customer's editor
  as the same user as their AI agents (`npm install` runs install scripts, `npm run dev` runs
  `astro.config.*`, Vite plugins and integrations, `npm test` runs the tests). Code that reads AI tools'
  sign-ins (`~/.claude`, `~/.codex`, `.cursor`, Copilot, Gemini) or other keys and passwords on
  the computer (`~/.ssh`, `~/.aws`, git and npm credentials, browser profiles, the keychain), the home
  folder or every environment variable, or that sends encoded data out or hides code as encoded text, is refused.
  Every dependency that runs an install script (in `package-lock.json`, direct or not) is listed for staff,
  and one from outside the public npm registry must be explained or removed.
  `node store-check.mjs` fails on the clearest of these. (review: `credentials`, `install scripts`)
- **No add-on manifest**: a whole site has only `template.json`, never the add-on's manifest file (`node store-check.mjs` names it if it finds one). (`bad_template`)
- No symbolic links, plain paths only (letters, digits and `_ @ ( ) + [ ] = , . ~ -`, at most
  240 characters). (`symlink`, `bad_path`)
- **Limits**: 50 MB in all, 5000 files, 10 MB per file. (`too_large`,
  `too_many_files`)

## 4. Run the check
From the top of your repository:

    node store-check.mjs

It checks the files your next commit will hold (what git tracks, plus new files `.gitignore`
doesn't hide) and prints PASS or FAIL for each rule, with the files to fix. It asks the platform for the
template's current release (and reads `git ls-remote --tags upstream`) and fails when yours is behind;
offline, that is a note. `npm run platform -- check` compares the managed files too. It also runs `npm audit` over
your `package-lock.json`: a high or critical problem in any package FAILS, listed with the package, what the problem is,
its advisory link and the version that fixes it (smaller ones are listed as notes). The review runs the same audit on every
submit. It needs Node 22.12 or later (the templates' own minimum) and npm, and changes nothing. Run it before every push you will submit.

## 5. Submit
1. Push your branch to GitHub.
2. In the developer portal: Submit an app → App code. Connect GitHub, pick the repository and the branch.
   The checks run at once; the first problem shows under App code with its file.
3. Add the listing: name, description, screenshots, your data note. Send it for review.
Submitting freezes the branch's latest commit. Push again and press Check again for a new version.

## 6. Sample data: `prisma/seed.sql`
**Required for a web app.** Submit refuses a web app without it (`seed_missing`) or with one that adds no
rows, not a single `INSERT` (`seed_empty`): the review test site and the store's preview must show a
working app. It is the only place sample data may live: your migrations create tables; they never insert
demo rows. The template ships an example `prisma/seed.sql` (a few sample jobs for its job board): replace it
with sample data for YOUR app. `node store-check.mjs` notes it while it is still the template's example.
- **Your public preview** (the store's "Try it"): loaded when the preview is built. You can load it again
  from the developer portal when you want fresh data.
- **Review**: loaded into the review test site's database.
- **Customers**: never loaded on its own. A customer may press "Load sample data" to put it into their
  STAGING database to try things out. It never goes into their live database.

Write it so that it can't hurt anyone:
- Safe to run twice: explicit ids with `ON CONFLICT DO NOTHING`, or `WHERE NOT EXISTS (…)`.
- Refuses a database that is in use. Start with a block that stops when real data is there, for example:

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "orders" WHERE "email" NOT LIKE '%@example.com') THEN
          RAISE EXCEPTION 'prisma/seed.sql is sample data and this store is already in use. Nothing was changed.';
        END IF;
      END $$;

- Wrap it in `BEGIN;` … `COMMIT;` so it loads all or nothing.
- Made-up people, `@example.com` addresses, no real names, photos or keys. No users with
  passwords: people sign up.
- Only your tables (and the template's own where it needs rows): nothing outside the site's database.

## 7. Review
Your version goes through levels, one after another. Each runs on its own and must pass before the next
starts; every failure names the file and the fix, and a new version starts again from the first level it failed:
1. Package: the rules above, checked again on the frozen version (an approval never passes an outdated template).
2. Security: secrets, code that reads sign-ins and keys, vulnerable packages, install scripts, outside payments, other databases.
3. Build: a real test site is made from your frozen version, its migrations run on its own database and your sample data is loaded.
4. Performance: load time on a slow phone connection.
5. UI and accessibility.
6. Data and privacy.
7. AI code review: a reviewer reads all of your code with AI help.
8. Human review: a reviewer opens the test site and ticks the checklist:
- [ ] It builds and the preview opens with no setup
- [ ] Sign-up and sign-in work
- [ ] View as admin opens its admin
- [ ] Its migrations ran on the preview database
- [ ] No leftover demo keys, passwords or accounts
- [ ] Sample data is only in prisma/seed.sql
- [ ] Price matches the listing and checkout
- [ ] Screenshots match the real app
- [ ] Data note is clear and accurate

Staff approve it or send it back with what to change. Approved, it is listed as a web app.

## 8. Your public preview
Once approved, the store hosts a preview of your web app built from the approved code, so people can try
it before they install it. Staff choose its address. It has its own database with your sample data, and it is yours to look after: it keeps
what you add. In the developer portal, "Get admin login" emails you an admin login for the preview (its
sign-in page, your email and a new password; change it after you sign in). Each person on your team gets
their own, as an admin, never as the owner: the owner of a site is only ever the customer who owns it.
Nothing in your code is needed for it. "Load sample data again" empties the preview and loads your seed
again, and your team's admin logins stay.

## 9. Paid listings
After review, staff set a price range and you confirm a price. The customer pays first: nothing is
made until the payment goes through, so a failed or abandoned payment leaves them nothing to clean up.
Once paid, they name it and their web app is made.
- **One-time price**: theirs to keep.
- **Monthly price**: the charge starts when they pay. If it stops (unpaid after the grace period,
  cancelled, refunded), their web app goes offline; nothing is deleted, and it comes back once a failed
  payment goes through. Make sure your listing says clearly what the monthly price is for.

## 10. Updates
Push new commits and submit an update: it goes through the same checks and review. Once approved,
customers who installed your web app see "Update available". Update MERGES your new version into their
copy: their own changes stay, and anything that clashes goes to their AI to resolve. Nothing goes live
until they publish. So that merges stay easy:
- Keep each update small and focused. A big rewrite clashes with what customers changed.
- Don't rename or move files without a reason: a moved file is a delete and an add for every customer.
- Migrations only add: new tables, new nullable columns, new indexes. Never edit, rename or delete a
  migration that is in a released version: it has already run on customers' databases. Every change is a
  new migration, safe for the previous version's code too.
- `package-lock.json` is never merged: it is made again from `package.json`.
  Change versions in `package.json`.
- `src/platform/` is never merged either: it follows the template's `docs/agent/upgrade.md`.
  Your update is on the current template like any submit.

Before you submit an update:
- [ ] You merged the newest template release, and `node store-check.mjs` passes.
- [ ] Your new migrations run on a database made by your PREVIOUS version, with data in it (check out the
      last released commit, migrate, add data or load `prisma/seed.sql`, then check out the new one and
      migrate again). Customers' databases are full; an empty one hides problems.
- [ ] The previous version's code still works on the new schema (customers may publish later).
- [ ] `npm run build` and `npm test` pass.
- [ ] Your "What's new" notes say, in plain words, what changed for the owner and anything their AI
      should know (a renamed setting, a new admin screen). Customers and their AI read them.
- [ ] The version number goes up: the last number for fixes, the middle one for new features.

## 11. Build it well
Customers own their copy and change it with their AI, so build it to be changed:
- Follow the template's rules in `AGENTS.md` and `docs/agent/`: they cover security and who may see what (`security.md`, `roles-and-permissions.md`), queries and caching (`performance.md`), the database (`database.md`), payments (`payments.md`), screens (`ui.md`) and SEO (`seo.md`). Run `docs/agent/review.md` before every submit.
- Put the owner's business in settings, not in code: shop name, texts, prices, colours and contact
  details come from the admin screens and the database, never hard-coded.
- Say where things live. Keep `README.md` up to date: what the web app does, where each feature's
  code is, and what an owner usually changes. The customer's AI reads it before changing anything.
- Plain names: files, folders, tables and settings named for what they are.
- Nothing that phones home: no tracking, licence checks or calls to your own servers. Outside services
  the owner connects with their own keys, entered as settings.
- Every route checks who is asking (the template's helpers do it): most leaks are one missing check.

## 12. Ready to submit
- [ ] `node store-check.mjs` passes, and `npm run build` and `npm test` pass.
- [ ] `template.json` is the current template version.
- [ ] A fresh copy: `npm install`, `npm run setup` and `npm run dev` work with no other setup.
- [ ] Sign-up, sign-in and your admin screens work (locally: the code in the `npm run dev` terminal, then
      `npm run dev-admin`); `prisma/seed.sql` is your app's sample data and loads twice without errors.
- [ ] `README.md` describes the web app for its owner and their AI.
- [ ] No keys, passwords or real people anywhere in the repository.
- [ ] Screenshots and the listing text match what the web app really does.

## 13. Where to read more
- Getting started: https://ezystudio.com/developers/docs/getting-started
- Database: Postgres and migrations: https://ezystudio.com/developers/docs/database
- Security rules: https://ezystudio.com/developers/docs/security
- Best practices: https://ezystudio.com/developers/docs/best-practices
- Submitting: https://ezystudio.com/developers/docs/submitting
- Review: https://ezystudio.com/developers/docs/review
- Updates: how they reach customers: https://ezystudio.com/developers/docs/updates
- The template's own rules: `AGENTS.md` and `docs/agent/` in this repository.
- Setting up, updates and steps for your AI: `DEVELOPERS.md`.
