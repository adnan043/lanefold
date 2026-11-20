---
title: Store apps: the read-only demo admin
read-when: before submitting this app to the store, changing its sign-in page, its roles, or anything an admin can save; when a submission was refused for its demo login or its payments
---
An app listed in the store must let a visitor look at its admin without changing anything. The
platform's previews of the listing (the reviewer's copy and the public "Try it") get a READ-ONLY
demo admin; a real install never does. Reviewers sign in with it by hand. An app whose demo is
missing, doesn't sign in, or can change anything is refused, and a listed one is taken down.

## The rule
- The demo account comes from ONE file, `prisma/demo-login.sql`, and nowhere else. The platform
  runs it ONLY on its previews, after `prisma/seed.sql` (and again after every sample-data reset).
  A real install deletes the file and never runs it.
- **Never put the demo account in `prisma/seed.sql`, a migration, or code.** Seed data and
  migrations reach real sites (a customer's staging, every install); this file never does.
- The file is data only: `INSERT … ON CONFLICT` and `UPDATE` into this app's tables, and
  `BEGIN;` / `COMMIT;`. Submit refuses anything else (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`,
  `DELETE`, `GRANT`, `COPY`, `DO` blocks, functions, dollar quotes, `WITH`).
- The demo signs in through the normal sign-in (`/site-api/auth/login`, email and password), and
  can open every admin screen. **Every write refuses it.**
- The sign-in page shows the demo's email and password: keep `<DemoLogin />` on it.

## Make the file: `npm run platform -- demo-login`
```sh
npm run platform -- demo-login --email demo@example.com --password "a long demo password"
```
It writes `prisma/demo-login.sql`: a `Demo (read-only)` role (`demo-read-only`, made when
missing) holding only the permission catalogue's `…:read` and `…:view` codenames
(`src/platform/auth/codenames.ts` + `src/server/permissions.ts`), and that user on it (plus
`member`), confirmed, with the template's own password hash. Safe to run twice. Run it again after
you add a read or view permission, or to change the address or password. Give the SAME email and
password on the submission form. Try it on your machine:
`npm run db:seed`, then `psql "$DATABASE_URL" -f prisma/demo-login.sql`, then sign in.

A site without the command (older than its template's 0.10.23): write the same statements by hand,
modelled on what the command prints: the role by slug with `ON CONFLICT ("slug") DO UPDATE`,
`role_permissions` by `SELECT` from `roles` and `permissions` by slug and codename (never ids), the
user with a hash `hashPassword()` made (`src/platform/auth/password.ts`), `ON CONFLICT ("email")`.

## Make every write refuse the demo role
The role holds no write permission, so every route guarded by `requirePermission(…:manage /
:update / :create / :delete)` already refuses it with 403. Check the rest:
- Every write route (`POST`, `PUT`, `PATCH`, `DELETE`, an Astro action, a form post) checks a
  write permission, never only "signed in" or a role slug. A write that only checks
  `requireAuth` (the account's own name, avatar, settings) lets the demo save: guard those with a
  permission too, or refuse the demo role there (`access.roles.includes('demo-read-only')` → 403).
- The UI hides or disables what the viewer can't do (`abilities` from `/me`), so the demo sees
  the screens without Save buttons that fail. The server still refuses: the UI is not the guard.
- No admin screen may let the demo grant itself a role, change a password other than through the
  normal account pages, or read a secret.
- Test it: sign in as the demo on your machine, open every admin screen, try every save. Each
  must answer 403 and change nothing.

## Show `<DemoLogin />` on the sign-in page
`src/pages/account/login.astro` has it already. A sign-in page of your own imports it:
```astro
---
import DemoLogin from '../../platform/DemoLogin.astro';
---
<DemoLogin />
```
It shows "Try the admin" with the email, the password, copy buttons and "Fill in" ONLY where the
platform set `SITE_DEMO_LOGIN` (its previews). Everywhere else it shows nothing. Never print the
demo credentials yourself, never hard-code them, and never read `SITE_DEMO_LOGIN` outside
`src/platform/` (`config.demoLogin` is the one reader).

## An app that sells: the owner picks the payment provider
An app that sells anything (a product, a booking, a membership, a plan) must let the owner who installs it choose, in
the app's admin, how they get paid: **Ezypay or their own Stripe or PayPal account**. Build it with
`payments-providers.md` (the helpers in `src/platform/payment-providers/`): all three supported, the choice in the
admin, each owner's own keys on the Secrets page, never yours. The submission form asks "Does your app sell
anything?"; a yes needs the payments agreement for that version. The reviewer opens the preview's admin and looks for
the choice: a version that sells without it is refused. The platform never reads or switches off your payment code.
The demo admin sees the choice but can't save it (every write refuses it, above).
