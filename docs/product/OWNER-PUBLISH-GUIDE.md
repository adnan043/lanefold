# Lanefold: owner publish guide

For the site owner. No technical knowledge needed. Read it top to bottom once, then follow the checklists.
Facts come from `RUNBOOK.md`, `owner-actions.md`, `review-migrations.md`, `review-hygiene.md` and `QA-CHECKLIST.md` (re-checked 2026-11-04 against the repo, `prisma/migrations`, `public/_headers`, `background.json` and the registered job handlers). Words in `code style` are names you can copy and search for.

## 1. What is ready

- The Lanefold app at `/app`: boards, lanes, cards, chat, members, invites, search, My Day, Inbox, settings, billing screens in test mode.
- The admin area at `/dashboard`: users, roles, workspaces, plan limits, billing settings, activity.
- Public pages: home, about, pricing, blog, sign-in pages.
- Database changes ("migrations"): 7 from the template are already live. Every other folder in `prisma/migrations/` (16 on 2026-11-04, the newest `20261104120000_custom_fields`; more may have been added since) is waiting and Publish applies them in order. The exact list on your live database is what `npx prisma migrate status` prints (ask the developer to run it against live before you press Publish). The code is written, builds and has tests.
- Security, speed and clean-up reviews are done. The migration review says: safe to apply in order. No migration needed a fix.

## 2. What is NOT ready (known limits)

- **No one has tested `/app` in a browser yet.** All checks so far were done by reading code and running automatic tests. Expect some rough edges. The click-through list is `QA-CHECKLIST.md`.
- **The 19 non-English languages are machine translations.** A "machine draft" notice shows. About 183 texts are still in English in every language. Arabic, Persian and Urdu (right-to-left) have not been checked in a browser.
- **No file uploads yet.** Uploads need the Storage pack, which only you can switch on. Until then the app says "File uploads are not switched on yet". That is correct, not a bug.
- **No real payments.** Checkout is a sandbox: no real money moves.
- **Invite emails are optional.** Invites always give a link to share. Emails need two secrets (`RESEND_API_KEY`, `MAIL_FROM`), see `owner-actions.md` "Phase 11".
- Built since the first version of this guide: a public read-only board page (`/b/<token>/`) with share links, table, calendar, timeline, dashboard and swimlane board views, notification emails (off for everyone until each person switches it on), a PWA manifest. Custom fields, dependencies, recurring cards, card templates, flows, saved-filter polish and share-link expiry are being added now: see section 4b. Not built: hard delete of a workspace (archive and restore exist), a service worker.

## 3. Decisions only you can make

Full text and recommended answers are in `owner-actions.md`. The numbers below are its numbers.

| # | Decision | Needed before Publish? |
|---|---|---|
| 18 | The pre-Publish checklist (section 4 below) | Yes |
| 17 | Accept two new building blocks: font `@fontsource-variable/inter` and `typescript` (recommended: yes to both) | Yes, quick |
| 5 | Font: the spec said Plus Jakarta Sans, the site uses Inter | No |
| 6 and 15 | Prices and wording on the pricing page (it shows no prices now) | No |
| 13 | Archiving a workspace does not stop its paid plan (recommended: cancel it on archive, or warn) | No |
| 14 | Notifications for people who lost access to a board | No |
| 16 | The pricing page can show old limits after you edit plan limits, until the next Publish | No |
| 7 | Admins see masked member emails (recommended: names only) | No |
| 10 and 20 | Native-speaker review of the 19 languages: or accept English on some screens at launch and say so | No |
| 19 | Public read-only board link: five yes/no questions | No (not built yet) |
| 21 | Optional mail polish | No |
| 1 | Delete account: built as recommended. Still yours: the privacy-policy wording | No, but write the text |
| 2, 3, 4, 8, 12 | Already settled. Nothing to do | No |

## 4. Before you press Publish

Do these in order. Tick each one.

1. **Take a snapshot (backup) of the live database.** There is no undo script for the database changes. The snapshot is your undo.
2. **Count the rows in the live `jobs` table** (for example in Prisma Studio). Publish deletes this table for good (`20261103083657_drop_job_board`, the old template job board). If it holds real jobs, export them first. If it is empty or only template samples, nothing is lost.
3. **Count workspaces with no members at all**, and leftover rows of deleted users. One migration (`20261103130000_account_deletion_cleanup`) deletes every workspace with zero members, archived ones too, with everything in them. Their files are deleted later and cannot be brought back. Expect 0 or a few. If the number surprises you, stop and ask.
4. **Commit the work.** Nothing of Lanefold is committed yet (only 2 commits exist). Commit everything, and include the **untracked migration folders** in `prisma/migrations/` together with `prisma/schema.prisma`. If you forget the new folders, the build will not ship them. This commit is also what you roll back to.
5. **Create the two sandbox prices.** Run both (the developer cannot do it for you):
   - `npm run platform -- prices add --key pro-monthly ...`
   - `npm run platform -- prices add --key team-monthly ...`
   Details are in `docs/agent/payments.md`. The names must be exactly `pro-monthly` and `team-monthly`. Until both exist, billing says "Payments are not set up yet" and checkout fails with `e_price_not_found`.
6. **Check `SITE_OWNER_EMAILS`.** It must hold your email. The admin account is made from it. You sign in at `/dashboard` with a 6-digit code sent to that address.
7. **Pick a quiet time.** Some migrations briefly pause saving on users, cards, messages and the activity log (seconds on a small site). Avoid a sign-up campaign or busy hour.
8. **Optional now, needed later:** switch on Storage and a pack (uploads). Add `RESEND_API_KEY` and `MAIL_FROM` as owner secrets in the dashboard (names only, never paste the values into a chat or a file): they switch on BOTH invite emails and notification emails. Without them nothing breaks: invites still give a link and nobody is emailed.
9. **Check the site address and owner address.** `SITE_URL` (the site's own address, set by the platform) and `SITE_OWNER_EMAILS` must both be set on the live site; `DATABASE_URL`, `JWT_SECRET` and `SITE_KEY` are set by the platform (you cannot and must not add them). Nothing else is required. Full list: `RUNBOOK.md` section 3b.
10. **Developer note (not for you):** after Publish, new database changes must have 26 lines about foreign keys and the 4 search indexes removed by hand. See `owner-actions.md` item 18.7.

## 4b. What the new features need from you

Each of these arrives with its own database change (a plain `CREATE TABLE`, nothing is deleted or rewritten) and needs NO secret, NO setting and NO price. They are ready as soon as Publish finishes. The only thing to do is look at them once (section 6b). If a feature below is not in the build yet when you read this, skip its line.

| Feature | Database change | Anything for you to do before Publish? |
|---|---|---|
| Lane pin and watch (per person) | `20261104100000_lane_prefs` (new table) | No |
| Custom fields on boards (text, number, date, checkbox, dropdown) | `20261104120000_custom_fields` (3 new tables) | No |
| Card dependencies ("blocked by") | `20261104130000_card_dependencies` (new table, two counters on cards) | No |
| Recurring cards | `20261104140000_recurring_templates` (new table) | No. A scheduled list makes the copies: ask the developer to confirm it is in the Jobs tab list of 4c before Publish (it was not registered on 2026-11-04) |
| Card and board templates | same migration (`card_templates`) | No |
| Flows (simple automations) | `20261104150000_flows` (new table) | No for the screens. Flows that email people use `RESEND_API_KEY` and `MAIL_FROM` (section 4, step 8) |
| Saved filters | table already exists (since the first Lanefold migration) | No |
| Share-link expiry for the public board page | none found yet (check `RUNBOOK.md` section 3c) | Decide the default (`owner-actions.md` item 19.3, recommended 30 days; Team may choose never). Old links keep working: expiry applies to links made after Publish |

New features may also bring new plan limits (for example how many flows a plan allows). Limits are edited in `/dashboard` Plan limits; the seeded values are already sensible, so you do not have to touch them.

## 4c. Background jobs you should see after Publish

Open the platform's Jobs tab (or ask the developer to run `npm run platform -- jobs`). You should see exactly these lists, all with retries and concurrency set:

| List | When (UTC) | What |
|---|---|---|
| `notification-emails` | every 15 minutes | Emails mentions and assignments, only to people who switched it on |
| `plan-sweep` | daily 04:00 | Paid plans that ended go back to Free |
| `grace-sweep` | daily 04:20 | Starts or clears over-limit grace periods |
| `old-data-cleanup` | daily 04:40 | Deletes old invites, join links and read notifications |
| `file-cleanup` | hourly | Deletes stored files whose card, board or workspace is gone |
| `invite-emails` | no schedule | Sends invite emails when an admin asks |

Recurring cards and flows with a daily trigger need one more scheduled list; it was not registered on 2026-11-04 (`RUNBOOK.md` section 3d). Once the developer adds it, it appears here too, and you should see it. A list that is in the Jobs tab but never runs, or runs and fails every time, is the one thing to report.

## 5. What Publish does

You press Publish in the editor. It runs four steps:

1. **Prepare.** Gets the committed work ready.
2. **Build.** Installs everything and builds the site (`npm ci`, `npm run build`). If this fails, nothing changes and the old version stays live.
3. **Migrate.** Applies the waiting database changes to the live database, in order. Each one is all-or-nothing. If one fails, the old version stays live. Two steps delete data (`drop_job_board`, `remove_job_permission`) and a third removes leftover data (`account_deletion_cleanup`), so **Publish waits for your approval**. Approve only after section 4 steps 1 to 3.
4. **Deploy.** Puts the new version live.

Do not edit database changes after they have run anywhere.

## 6. Check right after Publish

Open the live site and go through these. The full script is `QA-CHECKLIST.md`; read its first page, then at least:

- [ ] **Home page loads** and `/app` loads (no blank or error page).
- [ ] **Sign in at `/dashboard`** with your owner email and the emailed code (or the one-click "Open admin"). A normal (non-owner) account must not see admin screens.
- [ ] **Sign up a second account** in another browser and sign in at `/app`.
- [ ] **Create a board, add a card, move it** to another lane (drag, or "Move to..."). Reload: it stays there.
- [ ] **Send an invite** from Members: copy the link, open it as the second account, and join. Without the mail secrets you will see "Email not set up": that is fine.
- [ ] **Send a chat message** between the two accounts.
- [ ] **Billing:** Settings, Billing shows Free. Choose Pro: you reach the sandbox checkout. Complete it with the sandbox test card and check the plan changes. Then move your own test workspace to Team (`owner-actions.md` step 3).
- [ ] **Search indexes.** Four search indexes should exist: `boards_name_trgm_idx`, `cards_description_md_trgm_idx`, `cards_title_trgm_idx`, `users_name_trgm_idx`. The migration succeeds quietly even if the database refused them, so you must look. If any is missing, ask the platform to allow `pg_trgm`, then have the developer run the index SQL again (it is safe to repeat).
- [ ] **Jobs tab** shows the lists in section 4c, and the 15-minute `notification-emails` list has run at least once without errors.
- [ ] **Public board link:** in a board's settings create a share link, open it in a private window (no sign-in): you see the board read-only. Revoke it: the link stops working.
- [ ] **Security headers.** Open the home page and a `/app` page with the browser's developer tools (Network, first request, Response headers): both show `X-Content-Type-Options`, `Strict-Transport-Security` and `X-Frame-Options: DENY`. (The prerendered file `public/_headers` and the Worker code `src/platform/headers.ts` were compared on 2026-11-04 and match.)
- [ ] **Delete-account screen** at `/app/settings/account` opens and lists what blocks deletion.
- [ ] **Try 3 or 4 other languages**, and one right-to-left language (Arabic, Persian or Urdu), just to look.
- [ ] **Phone width:** open the site on a phone and check the board and the card.

File every problem with the bug template at the end of `QA-CHECKLIST.md`. Never paste passwords, sign-in codes or secrets into a report.

## 6b. Look at each new feature once

Not a test script, just a first look so you know it opened. Do it in a scratch board.

- [ ] **Custom fields:** board settings, add a dropdown field with two options and a number field; open a card, set both, reload: values stay. Delete the field: it disappears from cards.
- [ ] **Pin and watch a lane** from the lane menu; reload: the choice stays and only you see it.
- [ ] **Dependencies, recurring cards, templates, flows, saved filters, share expiry:** open the feature from the card or board menu, create one, reload, remove it. If the menu entry is missing, that feature is not in this build yet.

## 7. What can go wrong, and how to go back

| What you see | What it means | What to do |
|---|---|---|
| Build step fails | Nothing changed | Old version stays live. Send the error text to the developer. |
| Migrate step fails | That one change was undone; the old version stays live | Do not press Publish again. Send the error to the developer. A failed change must be resolved by hand (`migrate resolve`) before the next try. |
| Publish was done and the app is broken | Code problem | **Roll back: redeploy an earlier version** in the editor. |
| Search is slow on big workspaces | The four indexes are missing | See section 6, search indexes. |
| Deleting a user is refused with an explanation | Intended. The person owns a shared or paid workspace | Transfer ownership first. |
| Payments are not set up | The sandbox prices are missing | Section 4 step 5. |
| Nobody receives invite or notification emails | `RESEND_API_KEY` or `MAIL_FROM` is missing, or the sending domain is not verified (mail goes to spam) | Section 4 step 8; in the editor Preview mail is never sent by design. |
| A new feature screen answers "not found" or fails right after Publish | Its database change did not run | Ask the developer for `npx prisma migrate status` against live. Do not Publish again until it is resolved. |

**Rolling back.** Redeploying an earlier version puts the old code back. **The database changes stay applied.** They were written so older code can still run, but this has not been tried. Deleted data does not come back this way: only your snapshot from section 4 step 1 can restore it, and restoring it also removes anything people did after Publish. Decide with the developer before restoring.

## 8. After launch

- Say clearly to users: languages other than English are drafts, and files cannot be uploaded yet (if Storage is still off).
- Plan the native review of the languages (`owner-actions.md` items 10 and 20; start with bn, hi, ur, ar, es, fr).
- Write the privacy-policy text about deleted accounts (`owner-actions.md` item 1).
- Ask the developer for a full `QA-CHECKLIST.md` pass in a real browser; nothing has had one yet.
