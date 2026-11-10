# Owner actions (Lanefold)

Checked against the repo on 2026-11-03 (updated after the trigram, archive and account-deletion work). Env var values are never written here, only names. Full picture: `RUNBOOK.md`; status: `STATUS.md`; docs index: `RUNBOOK.md` section 12.

Local setup done by the assistant: Postgres in Docker (`lanefold-pg`, port 5480, databases `lanefold` and `lanefold_test`), `.env` with a generated JWT secret.

## Do these before or at Publish
1. **Commit first.** Nothing of the Lanefold work is committed (only 2 commits exist: template import, MVP schema). Commit before Publish so a rollback exists.
2. **Set `SITE_OWNER_EMAILS`** (the admin account is made from it; sign in at `/dashboard` with the emailed code).
3. **Sandbox prices:** `npm run platform -- prices add --key pro-monthly ...` and `--key team-monthly ...` (`docs/agent/payments.md`). The keys come from `plan_limits.price_key_monthly`. Until both exist, billing shows "Payments are not set up yet" and checkout answers 404 `e_price_not_found`. Then move your own test workspace to Team through the sandbox checkout.
4. **Turn on Storage and a pack** (uploads answer `E_STORAGE_NEEDS_PACK` until then).
5. **Publish from the editor** (Prepare, Build, Migrate, Deploy). Every migration after the seven template ones (16 on 2026-11-04 and more may be added) is not yet on the live database by this doc's record (all in `prisma/migrations/`; confirm with `npx prisma migrate status`). Two are destructive and Publish waits for approval (`drop_job_board`, `remove_job_permission`):
   - `20261102120928_lanefold_mvp`: the whole product schema; seeds `app_settings` (PAID, 14 days grace) and the three plans.
   - `20261102124901_cards_board_open_idx`: partial index `cards_board_id_lane_id_position_id_open_idx` on `cards (board_id, lane_id, position, id) WHERE archived_at IS NULL` (raw SQL only; Prisma cannot express it).
   - `20261103051050_memberships_workspace_last_event`: adds `memberships.workspace_id` and `memberships.last_event_at`, plus index `memberships_workspace_id_status_idx`.
   - `20261103053243_query_plan_indexes`: extra indexes from `review-query-plans.md`.
   - `20261103083657_drop_job_board`: drops the template job board table.
   - `20261103090000_remove_job_permission`: removes the job permission.
   - `20261103100000_search_trigram`: `pg_trgm` and GIN indexes for search; guarded, creates nothing if the extension is not allowed.
   - `20261103100100_workspace_archive`: `workspaces.archived_at`, `archived_by`, partial index `workspaces_archived_idx`.
   - `20261103130000_account_deletion_cleanup`: nullable author columns, 25 foreign keys to `users`, triggers, the `file_deletions` outbox table.
   - `20261103140000_chat_thread_index`: index `messages_conversation_id_parent_id_seq_idx` for thread and top-level message pages.
   - `20261103150000_workspace_removals`: table `workspace_removals` (when a member left, so an older link cannot bring them back).
   - `20261103160000_invite_email_status`: invite email state columns on `workspace_invites` and two hourly-limit indexes (see Phase 11 below).
   - `20261103170000_audit_actor_action_idx`: index `audit_events_actor_user_id_action_id_idx` on `audit_events (actor_user_id, action, id DESC)` for the export rate limit.
   - `20261104090000_notification_emails`: three columns on `user_profiles` (`email_notify_mode` default `off`, `email_notify_cursor`, `email_notified_at`), a check constraint and an index; guarded, additive.
   - `20261104100000_lane_prefs`: new table `lane_prefs` (pin and watch a lane, per person). Additive.
   - `20261104120000_custom_fields`: three new tables for board custom fields and their card values. Additive.
   - `20261104130000_card_dependencies`: table `card_dependencies` and two counters on `cards`. Additive, repeat-safe.
   - `20261104150000_flows`: table `flows` (board automations). Additive, repeat-safe.
   - `20261104140000_recurring_templates`: tables `card_recurrences` and `card_templates`. Additive, repeat-safe. Share-link expiry had no migration yet; see `RUNBOOK.md` section 3c for the current list. Run `npx prisma migrate status` against live to see the exact pending set.
   Destructive or data-removing, so approve with care: `drop_job_board`, `remove_job_permission`, `account_deletion_cleanup` (items 18.2 and 18.3). Everything else only adds.
   Existing template migrations (already live): `20261019090000_init`, `..090100_site_auth`, `..090200_seed_roles`, `20261023080001_job_deliveries`, `20261026090000_account_security`, `20261026120000_sign_in_codes`, `20261029090000_payments`.

## Phase 11: invite emails (optional; works without it)
Invites always return a link the admin can share. To ALSO email it, add two owner secrets in the dashboard (names only here, never the values):
- `RESEND_API_KEY`: the API key of a Resend-compatible mail account (calls `https://api.resend.com/emails`).
- `MAIL_FROM`: the verified sender, for example `Lanefold <no-reply@your-domain>`.
Verify the sending domain with the mail provider and publish its SPF and DKIM DNS records, or the mail lands in spam. New migration `20261103160000_invite_email_status` (nullable email columns on `workspace_invites`; Publish runs it). The background list `invite-emails` (retries 4, concurrency 2, no schedule) is in `background.json`; raise the job rate in the Jobs tab if many invites are sent at once. Limits: 30 invite emails per workspace and 10 per inviter per hour, 5 sends per invite. Until both secrets exist (and always in the editor Preview), the inviter sees "Email preview (not sent: email is not set up)" in the invite dialog and the invite shows "Email not set up" with a resend option. The invitee's address is never stored. Templates are in 20 languages; the 19 non-English ones are drafts that need native review (`src/server/mail/templates.ts`).

## Secrets and settings, in one place
Only these are yours to set (names only): `SITE_OWNER_EMAILS` (site settings), owner secrets `RESEND_API_KEY` and `MAIL_FROM` (optional; they switch on invite emails, notification emails and any flow email), Storage and a pack (uploads), sandbox prices `pro-monthly` and `team-monthly`. The platform sets `SITE_URL`, `DATABASE_URL`, `JWT_SECRET`, `SITE_KEY`; never ask for or paste them. No new secret is needed for custom fields, dependencies, recurring cards, templates, flows, saved filters or share expiry. Table in `RUNBOOK.md` section 3b.

## Dependencies
Installed (`package.json`): `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2, `fractional-indexing` 4.0.0; dev: `typescript` 7.0.2 with an `npm run typecheck` script (decision 12). `@tanstack/react-virtual` is now installed too (Table view windowing; approved in SPEC). Approved but NOT installed: `marked`. Nothing to confirm unless you want them added.

## Decisions for the owner (1 to 4, 8 and 12 settled; 13 to 16 and 17 to 21 are new; the rest open)
1. **Delete-account design: SETTLED, implemented with the recommended answers** (`delete-account-design.md`, migration `20261103130000_account_deletion_cleanup`, `src/server/jobs/files.ts`). Deletion is blocked with `last_workspace_owner`, `paid_workspace` or `workspace_needs_action`; authored content is kept with the author NULL; personal rows cascade; orders and memberships keep rows with `user_id` and `email` wiped; files go to an outbox deleted by the hourly `file-cleanup` job. Still yours: the privacy-policy wording, and the in-app preflight screen now exists (`GET /site-api/account/delete-preflight`, shown at `/app/settings/account`; `src/server/routes/account-preflight.ts`, `src/app/settings/account.tsx`), not yet opened in a browser. The five questions and the answers built:
   1. Block deletion for the only owner of a workspace until they transfer ownership or delete it? Recommended YES, with a preflight list and one-click "Make owner" / "Delete workspace".
   2. Messages and comments of a deleted person: keep as "Deleted user" or erase? Recommended KEEP, anonymised (author NULL); say so in the privacy policy.
   3. Their uploaded files? Recommended KEEP files on shared cards and chats; delete files in DMs whose other side is gone (simplest first step: keep all, delete with their card/workspace).
   4. Paid history? Recommended KEEP orders and memberships, wipe `user_id` and `email`; a paid workspace must be transferred or deleted first (Q1).
   5. Friendly in-app error for API callers bypassing the preflight? Recommended ACCEPT a generic error.
2. **Viewer board override.** Current code (`resolveBoardRole`, `src/server/workspaces.ts`): workspace owner/admin are always board admin; a private board with no override is invisible (null); otherwise an override wins, even over a workspace `viewer` (a viewer with a board `member`/`admin` override can write); with no override, workspace member is board member and viewer is board viewer. Reachable now, because creating a board inserts the creator's `board_members` admin row (`boards.ts`). Keep (review says intended) or forbid an override above the workspace role.
   **DECIDED (code): viewer always wins.** `resolveBoardRole` clamps a workspace viewer to board viewer whatever the override; demoting to viewer also downgrades their `board_members` rows in the same transaction. Nothing left to choose.
3. **Trigram index: SETTLED, implemented** (`20261103100000_search_trigram`, GIN on `cards.title`, `cards.description_md`, `boards.name`, `users.name`). The migration is guarded, so Publish succeeds even if the live database refuses `CREATE EXTENSION pg_trgm`; then search simply stays unindexed. Your call: after Publish, check the indexes exist (if not, ask the platform to allow `pg_trgm` and run the migration SQL again by hand).
4. **Workspace archive instead of delete: SETTLED, implemented** (`20261103100100_workspace_archive`, `routes/workspace-settings.ts`). The owner archives with a typed name and can restore; an archived workspace is closed to everyone; nothing is hard-deleted, because only some tables have foreign keys. Your call: whether you ever want a real hard delete (it needs a per-table purge).
5. **Font.** SPEC says self-hosted Plus Jakarta Sans; `global.css` uses Inter, installed from the npm package `@fontsource-variable/inter` (imported in `Base.astro` and `App.astro`). `public/fonts` exists and holds Noto fonts for Arabic, Bengali, Devanagari, Thai, Urdu and CJK, but no Plus Jakarta Sans.
6. **Prices for the pricing page.** `pricing.astro` shows no prices (its FAQ says each plan is a flat price per workspace); also needed for the sandbox prices in step 3.
7. **Admin sees masked emails.** The members directory shows a masked email to workspace admins/owners. `review-privacy.md` P3: the mask leaks the first letter and the full domain. Recommended: show names only, or mask the domain too.
8. **`/jobs` template pages: DONE.** The pages, route, permission, dashboard screen and table are removed (migrations `drop_job_board`, `remove_job_permission`). Nothing left to decide.
9. **Storage pack:** turn on (step 4), or uploads fail.
10. **Native-speaker review of the 19 non-English catalogs** (machine drafts marked `needsReview`; start with bn, hi, ur, ar, es, fr; see `i18n-qa.md`).
11. **Commit before Publish** (step 1).
12. **Typecheck: SETTLED.** `npm run typecheck` reported 0 errors on 2026-11-03 (typed router wrapper `src/app/nav.tsx`); it can act as a gate. Nothing to decide unless you want it in the build.
13. **Archiving a workspace does not cancel its paid subscription** (billing continues until the owner cancels). Recommended: cancel the subscription on archive, or warn the owner in the archive dialog.
14. **Notifications for users who lost access.** The list and unread count scan rows of boards or chats a user can no longer see. Recommended: delete or mark read those rows when access is removed (board member removal, leaving a conversation, workspace removal), plus a scan cap.
15. **Pricing amounts** (extends item 6): the amounts to show on `pricing.astro`, and the wording of the "Free for all" pricing note (keep or remove).
16. **Prerendered pricing can show stale plan limits** after you edit plan limits in `/dashboard`, until the next build. Recommended: read limits at request time (cached) or rebuild after editing.

## New decisions (second and third review round)
Each has a recommended answer. Where a number says "11" or "26" it comes from `review-migrations.md` (2026-11-03); recount with `git status` and the drift check before relying on it.

17. **Confirm two new dependencies** (`review-hygiene.md`): `@fontsource-variable/inter` 5.3.0 (runtime, exact pin) and `typescript` ^7.0.2 (dev, for `npm run typecheck`). Neither was in the expected list. Recommended: YES to both (Inter is the font `global.css` already uses, see item 5; typecheck was clean on 2026-11-03).
18. **Pre-Publish checklist for the migrations** (`review-migrations.md`; verdict there: safe to apply in order, no migration edits needed). Recommended: do all of these, in this order.
    1. Snapshot (back up) the live database. There is no rollback script.
    2. Count rows in the live `jobs` table. `20261103083657_drop_job_board` drops it for good; export first if it holds real jobs.
    3. Count workspaces with NO members (and rows of already-deleted users). `20261103130000_account_deletion_cleanup` deletes memberless workspaces, archived ones included, with their content, and queues their files for permanent deletion. Expect 0 or a few.
    4. Choose a quiet window: the migrations take brief write locks on `users` (25 foreign keys), `cards`, `messages` and `audit_events`.
    5. Commit the 11 untracked migration folders together with `prisma/schema.prisma` (item 1 above), or the build will not ship them.
    6. After Publish, check that the four trigram indexes exist (`boards_name_trgm_idx`, `cards_description_md_trgm_idx`, `cards_title_trgm_idx`, `users_name_trgm_idx`); the migration succeeds silently without them if `pg_trgm` is refused (item 3).
    7. Developer rule from now on: every `prisma migrate dev --create-only` will propose dropping 26 foreign keys to `users` and the 4 trigram indexes (the schema cannot express them). Strip those lines from the generated SQL, and never add relations to `users` in `schema.prisma` without a plan.
    Also expect: deleting a user can now be refused with an explanation (owner of a shared or paid workspace).
19. **Public read-only board link** (`public-board-design.md` section 13; five yes/no decisions, recommended answers first):
    1. Show assignee first name and last initial by default, with a per-link switch to hide all names? Recommended YES.
    2. Allow public links on the Free plan? Recommended NO (Pro 5, Team 50 boards; Free sees an upgrade prompt).
    3. Default expiry of 30 days on every new link (Team may choose "never")? Recommended YES.
    4. Hide link attachments and all comments forever on the public page, with no per-board option to show them? Recommended YES.
    5. Keep the board name and cover out of the OG/Twitter preview (generic card only)? Recommended YES (opt-in later).
20. **Native review of the 19 machine-written catalogs** (extends item 10; `i18n-qa.md`). The 2026-11-03 re-check found 183 keys whose value is identical to English in all 19 catalogs (import/export, saved filters, invite email, calendar and table views and others; the list is in `i18n-qa.md`), plus per-language leftovers. Some are legitimate cognates. Recommended: send the 183-key list and the first catalogs (bn, hi, ur, ar, es, fr) to native reviewers, or accept English for those screens at launch and say so.
21. **Mail polish, all optional** (a separate mail review document was not found in `docs/product/`, so this follows the request wording; details unverified). (a) An unsubscribe or "why you got this" line in invite emails. (b) A preheader line. (c) Send each email in the RECIPIENT's language, not the inviter's. Recommended: skip (a) and (b) while the only mail is a one-off invite the inviter chose to send; do (c) only if a native review of the 20 templates happens (item 20).

## New decisions (2026-11-04)
22. **Publish the migrations to the live database** (now 14, newest `20261104090000_notification_emails`). Only you can; follow the checklist in item 18 first. Notification emails and the public board page do nothing useful until then.
23. **Native-speaker review** of the 19 catalogs now covers every key (all catalogs complete as of 2026-11-04, including `importExport.*`, `views.tl.*`, `notifEmail.*`). Recommended: still start with bn, hi, ur, ar, es, fr (extends items 10 and 20).
24. **Public board share links (built).** Create, rotate and revoke are in the board settings drawer for board admins. Decide: expiry dates, a plan limit, and whether private boards may be shared (today they are refused).
25. **Notification emails:** add `RESEND_API_KEY` and `MAIL_FROM` (same as invite emails, Phase 11), then each person switches it on in Settings, Notifications. Nothing is mailed to anyone who has not. Decide whether digest (one per 23 h) and immediate (one per hour) are the right limits.
26. **Admin masked emails (item 7), partly done:** the Lanefold mask now hides the domain; the platform's own mask in `src/platform/auth/admin.ts` is managed code and still uses the older one. Say if that matters; it can only change with a platform upgrade.
27. **(Not applicable until such routes exist.) Notifications after board-only removal or leaving a chat:** cleanup exists for workspace member removal only; the unread count is capped at 500 scanned rows (item 14 is partly done).

## Later
Connect a live payment gateway (no code change expected). Schedule Phases 5 to 12 after about two weeks of team use. Raise the background job rate if needed. If you run parallel agents, give each worktree its own Postgres database (HANDOFF section 6); integration tests empty their database.

## New decisions (2026-11-04, migrations and new features)
28. **Publish approval.** Publish will pause for approval on the destructive steps (`drop_job_board`, `remove_job_permission`); `account_deletion_cleanup` also removes data. Do items 18.1 to 18.3 first. Everything added after 2026-11-04 morning only adds tables and columns.
29. **New features need nothing from you before Publish** (custom fields, dependencies, recurring cards, templates, flows, saved filters, lane pins): no secret, price or setting. Look at each once after Publish (`OWNER-PUBLISH-GUIDE.md` section 6b). Flows that send email need the mail secrets of item 25.
30. **Share-link expiry** (extends item 24 and 19.3): recommended default 30 days for new links, Team may pick never; old links keep working until revoked.
31. **Check the Jobs tab after Publish:** you should see `notification-emails`, `plan-sweep`, `grace-sweep`, `old-data-cleanup`, `file-cleanup` and `invite-emails` (plus any list the developer adds for recurring cards or scheduled flows). Report a list that fails every run.
