# Lanefold runbook

Facts below were checked against the code on 2026-11-03. Env var values are never written here, only names.

## 1. What Lanefold is
A kanban app with built-in chat, on ONE Astro + Cloudflare Worker project (Hono is the only backend, Postgres via Prisma is the Site Database). The product lives at `/app/*` (host page `src/pages/app/[...path].astro`). The platform admin lives at `/dashboard` (React SPA in `src/portal/`). Public pages: `/`, `/about/`, `/pricing/`, blog, `/account/*`. Specs: `SPEC.md`, later decisions `HANDOFF.md` (wins), look `visual-identity.md`. `AGENTS.md` wins over all.

## 2. Repo map
| Path | What |
|---|---|
| `src/app/` | The product SPA: `AppRoot.tsx`, `routes.tsx`, `shell.tsx`, `queries.ts`, `api.ts`, `workspace.tsx`, `onboarding.tsx`, `setup-checklist.tsx`, `shortcuts.tsx`, `plan-limits.tsx`, `templates.ts`, `board-state.ts`, `use-board-sync.ts` (board polling). Folders: `boards/` (board screen, canvas, lanes, cards, dnd, composers), `cards/` (card panel, checklists, comments, attachments, pickers), `chat/` (conversations, messages, composer, mentions, pulse polling), `inbox/`, `my-day/`, `members/` (members screen, invite modal, resend-email modal, join screen), `notifications/` (bell), `palette/` (Cmd+K), `import-export/` (board export menu, Trello import strings), `settings/` (workspace, billing, appearance, language, import-export, account with the delete-account preflight). |
| `src/server/app.ts` | Mounts all Hono routes under `/site-api`. |
| `src/server/routes/boards.ts` | Workspaces list/create, boards, stars, `/boards/:id/rev` and `/changes` (sync), lanes, cards (create, patch, move, archive, restore). |
| `.../card-detail.ts` | Card detail, details patch, activity, people, labels, assignees, checklists and items, comments, attachments (link, upload, complete, view, rename), cover. |
| `.../chat.ts` | `/chat/pulse`, conversations (channels, groups, DMs, board chat), messages (send, edit, delete), read marks, mute, reactions, pins. |
| `.../chat-extras.ts` | One conversation detail; workspace member search for mentions. |
| `.../members.ts` | Members list, role change, remove, leave, join links, invites (optionally emailed), resend a failed invite email, accept invite. |
| `.../workspace-settings.ts` | Rename workspace, transfer ownership, archive and restore (owner), archived list, user preferences. |
| `.../account-preflight.ts` | `GET /site-api/account/delete-preflight`: what blocks deleting the signed-in person's account (`last_workspace_owner`, `paid_workspace`, `workspace_needs_action`) and what would be removed or kept anonymous. Own data only, read-only. Shown at `/app/settings/account`. |
| `.../import-export.ts` | Trello import (dry run, start, cards in chunks) and board export as JSON or CSV. |
| `.../saved-filters.ts` | Saved filters of a board (list, create, rename, delete). |
| `.../notifications.ts` | Notification list, unread count, read, read-all. |
| `.../search.ts` | Workspace search, My Day, Inbox list, quick capture, triage to a board. |
| `.../billing.ts` | Workspace billing, plan checkout, `billing/mine`, owner-only settings, plan limits, all-workspaces list. |
| `.../checkout.ts`, `site.ts` | Template: generic checkout, memberships, site info. The job board route is removed. |
| `src/server/workspaces.ts` | Workspace/board access (`membership`, `requireWorkspaceRole`, `boardAccess`). |
| `src/server/entitlements.ts` | THE only place deciding limits (see section 6). |
| `src/server/permissions.ts` | Platform-admin permission catalogue. |
| `src/server/payments-hooks.ts` | Records orders/memberships, `applyWorkspacePlan`. |
| `src/server/{notifications,general-channel,card-faces,validation}.ts` | Notification writer, default "general" channel, card summary shapes, shared validators. |
| `src/server/background.ts`, `src/server/jobs/` | Wires every list to its handler. Scheduled handlers (`index.ts`), sweep logic (`sweeps.ts`), stored-file cleanup (`files.ts`), invite email sending (`invite-email.ts`), paging/retention constants (`logic.ts`). |
| `src/server/mail/` | `send.ts` (provider-agnostic sender, Resend-compatible API, 8 s timeout, never logs address or key) and `templates.ts` (invite email in 20 languages, link builder). |
| `src/portal/` | `/dashboard`: overview, users, roles, activity, account, plus Billing, Plan limits, Workspaces (`screens/`; the Jobs screen is removed), and the UI kit `ui/` (incl. `command`, `popover`, `chips`). |
| `src/i18n/` | `core.ts`, `resolve.ts`, `format.ts`, `errors.ts`, `locales.ts`, `meta.ts`, `messages/*.json`: 20 catalogs (en plus ar bn de es fa fr hi id it ja ko pt ru sw th tr ur vi zh). |
| `src/pages/`, `src/styles/`, `src/content/` | Public pages, CSS, site words and blog. |
| `src/platform/**`, `docs/agent/**` | Managed by the platform. Never edit. |
| `prisma/` | `schema.prisma`, `migrations/` (7 from the template, already live; every later folder is new for Lanefold and not yet live; list them with `ls prisma/migrations`, confirm with `npx prisma migrate status`; details and risk in section 3c). Never edit an applied migration. |
| `tests/`, `tests/integration/` | Unit and integration tests. |

## 3. Run locally
- Postgres runs in Docker (container `lanefold-pg`, port 5480, databases `lanefold` and `lanefold_test`); `docker start lanefold-pg` if it is stopped (it listens on `localhost:5480`). Both databases need `npx prisma migrate deploy` after every new migration folder (the newest is listed by `ls prisma/migrations`; `npx prisma migrate status` names what is pending); run it once per database by pointing `DATABASE_URL` at it for that one command. Never run integration tests against `lanefold`: they empty the tables.
- `.env` (git-ignored, never commit, never print) holds: `SITE_URL`, `DATABASE_URL`, `JWT_SECRET`, optional `SITE_KEY`, `SITE_PREVIEW`, `SITE_OWNER_EMAILS`. Invite email also needs two owner secrets added in the dashboard (not in `.env`): `RESEND_API_KEY` and `MAIL_FROM` (section 8b). Template: `.env.example`. With `SITE_OWNER_EMAILS` empty locally, the first account to confirm its email becomes owner.
- Apply the schema: `npx prisma migrate deploy` (against the `DATABASE_URL` database).
- Start: `npm run dev` (runs `prisma generate` then `astro dev`). In the editor the Preview already runs this: do not start a second dev server. Build: `npm run build`.
- Always read env through `config` (`src/platform/config.ts`), server side only.

## 3b. Environment and owner secrets (names only, checked 2026-11-04)
Read only through `config` (`src/platform/config.ts`) and `config.ownerSecret('NAME')`. Nothing else is required to run or Publish.
| Name | Who sets it | Needed for | If missing |
|---|---|---|---|
| `SITE_URL` | platform (plain var) | the site's own address, canonical URLs, links in emails | the platform's own `/site-api` calls fail |
| `DATABASE_URL` | platform (secret) | the Site Database | every route answers 503 `site_database_disabled` |
| `JWT_SECRET` | platform (secret) | sign-in tokens, sealed invite payloads | auth answers 503 `auth_not_configured` |
| `SITE_KEY` | platform (secret) | relayed account emails | account emails do not go out |
| `SITE_OWNER_EMAILS` | owner, in the site settings | creates the admin account at `/dashboard` | nobody can open the admin |
| `SITE_PREVIEW` | platform, editor Preview only (`1`) | Preview behaviour (no mail, no `X-Frame-Options`) | n/a |
| owner secret `RESEND_API_KEY` | owner, dashboard | invite emails, notification emails, flow emails | mail is skipped: invites show "Email not set up"; notification emails send nothing; no error to users |
| owner secret `MAIL_FROM` | owner, dashboard | same as above (verified sender, for example `Lanefold <no-reply@your-domain>`) | same |
| Storage and a pack | owner, platform Storage tab | file uploads | uploads answer `E_STORAGE_NEEDS_PACK` |
| sandbox prices `pro-monthly`, `team-monthly` | owner, `npm run platform -- prices add ...` | plan checkout | billing says "Payments are not set up yet" |
`ownerSecret` is read only in `src/server/mail/send.ts` and the jobs that call it. Never put a value in `.env`, a doc, a log or git.

## 3c. Migrations: order, repeat-safety, destructive ones (checked 2026-11-04)
Order: every folder sorts after the previous one by name (lexicographic = chronological); verified for all folders present. `prisma migrate status` on local `lanefold_test` (read only) listed all but the newest as applied; the live database has only the 7 template migrations.
| Class | Migrations | Repeat-safe if run by hand? |
|---|---|---|
| Template, already live | `init`, `site_auth`, `seed_roles`, `job_deliveries`, `account_security`, `sign_in_codes`, `payments` | n/a, never edit |
| Plain CREATE, atomic (BEGIN/COMMIT, Prisma records once; NOT repeat-safe) | `lanefold_mvp`, `cards_board_open_idx`, `memberships_workspace_last_event`, `query_plan_indexes`, `workspace_archive`, `workspace_removals`, `invite_email_status`, `lane_prefs`, `custom_fields` | No, and it does not matter: one transaction each, they cannot half-apply |
| Written to be repeat-safe (`IF NOT EXISTS` / guarded `DO`) | `search_trigram` (guarded, swallows errors: verify the 4 `*_trgm_idx` indexes exist), `chat_thread_index`, `audit_actor_action_idx`, `notification_emails`, `card_dependencies`, `recurring_templates`, `flows` | Yes |
| Destructive | `drop_job_board` (`DROP TABLE jobs`, rows lost; no BEGIN/COMMIT, one statement is atomic), `remove_job_permission` (deletes permission `site:job:manage` and its role grants), `account_deletion_cleanup` (deletes memberless workspaces, orphan rows, queues their files for deletion; adds 25 foreign keys to `users` and triggers that make "delete user" refuse owners of shared or paid workspaces; not repeat-safe) | n/a. Publish waits for approval; snapshot first |
Lock notes: `account_deletion_cleanup` holds locks on `users` until commit; `audit_actor_action_idx` and the trigram builds briefly block writes on their tables. Pick a quiet time.
Developer rule: every `prisma migrate dev --create-only` proposes dropping 26 foreign keys to `users` and the 4 trigram indexes; delete those lines from the generated SQL. Never edit an applied migration. New migrations are timestamped after the last one; do not reuse a timestamp.
Newer folders (each reviewed read-only on 2026-11-04): `lane_prefs` (new table, FK to `lanes` cascade, no FK to `users`), `custom_fields` (3 new tables, cascades from boards and cards), `card_dependencies` (2 counters on `cards` with default 0, new table, guarded), `recurring_templates` (tables `card_recurrences` and `card_templates`, guarded), `flows` (new table with a CHECK on trigger kind, guarded). All additive, none destructive.
Share-link expiry had no migration folder on 2026-11-04 (it may reuse `boards` columns, check `schema.prisma`); if one appears, read it and add it to the table above. The owner guide `OWNER-PUBLISH-GUIDE.md` section 4b lists what the owner must do for each.

## 3d. Other pre-Publish checks (2026-11-04)
- `public/_headers` vs `src/platform/headers.ts`: same six headers and values (`nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, `Permissions-Policy camera=(), microphone=(), geolocation=(), payment=()`, `COOP same-origin`, `X-Frame-Options DENY`, `HSTS max-age=15552000`). The only difference is intended: the Worker omits `X-Frame-Options` and HSTS in the editor Preview. `/fonts/*` is cached for a year in `_headers`; the build adds the `/_astro/*` rule.
- `background.json` vs `src/server/background.ts`: 6 lists, all 6 have a handler (`invite-emails`, `notification-emails`, `plan-sweep`, `grace-sweep`, `old-data-cleanup`, `file-cleanup`); 5 are scheduled, `invite-emails` is send-only. GAP to close before Publish: `recurring_templates` creates card copies "by a scheduled job" and the `flows` table allows a `daily_due` trigger, but on 2026-11-04 `background.json` and `src/server/background.ts` (and `scheduledJobs` in `src/server/jobs/index.ts`) had NO list for either. Until the developer adds one (list, schedule and handler, in both files, then `npm run platform -- jobs` says ok), recurring cards will never create copies and `daily_due` flows never fire; nothing else breaks.
- Dependencies: `@tanstack/react-virtual` IS now installed (Table view windowing); `marked` is not. The owner approved both in SPEC; nothing to confirm.

## 4. Tests
- Unit: `npm test` (runs `prisma generate` then `vitest run`). Integration tests run only when `TEST_DATABASE_URL` is set, otherwise they are skipped. The full suite last ran green apart from the items noted in `review-*.md`.
- Integration steps (names only, never print values): (1) make sure the `lanefold_test` database exists on the Docker Postgres; (2) in your shell, set `TEST_DATABASE_URL` to a connection string for `lanefold_test` (same server and credentials as `DATABASE_URL`, database name `lanefold_test`); (3) run `npx prisma migrate deploy` once with `DATABASE_URL` temporarily pointing at that database (so it has every migration, including the newest); (4) run `npm test`. Do not `echo` or `cat` `.env` or these variables. The suite EMPTIES the tables of that database, so never point it at `lanefold`. Files run one after another (`fileParallelism: false`). A new table must be added to the `TRUNCATE` in `tests/integration/support/harness.ts`.
- Files: `tests/integration/*.test.ts` and `tests/*.test.ts` (units).
- Typecheck: `npm run typecheck` (`tsc --noEmit`; `typescript` is a devDependency now). It reported 0 errors on 2026-11-03 (`src/app/nav.tsx` wraps TanStack `Link` / `useNavigate` with typed routes; the integration harness json is typed `any`). Run it again before relying on it.
- Dependencies installed for the product: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `fractional-indexing`. `@tanstack/react-virtual` is installed (Table view); `marked` is approved but NOT installed.

## 5. Data model (`prisma/schema.prisma`, 997 lines, tables are `@@map` snake_case)
- Auth (template): `User`, `Role`, `Permission`, `RolePermission`, `UserRole`, `RefreshToken`, `PasswordReset`, `EmailVerification`, `SignInCode`, `LoginAttempt`, `EmailChange`, `RecoveryCode`, `AuditEvent`, `AuthState`.
- Platform glue: `JobDelivery`, `PaymentEvent`, `Order`, `Membership` (subscriptions), (the `Job` job board model is dropped).
- Workspaces: `UserProfile`, `Workspace` (plan, memberLimit, memberCount, storageUsedBytes, graceUntil), `WorkspaceMember` (role), `WorkspaceInvite` (also the invite email state: `email_status`, `email_queued_at`, `email_sent_at`, `email_attempts`; never the address), `WorkspaceJoinLink`, `WorkspaceRemoval` (when someone left, so an older link cannot bring them back).
- Boards: `Board` (has a rev counter for sync), `BoardMember` (per-board override), `BoardStar`, `Lane`, `Card`, `CardMember`, `CardWatcher`, `Label`, `CardLabel`, `Checklist`, `ChecklistItem`, `Comment`, `CommentMention`, `Attachment`, `CardLink`, `Activity`, `Notification`, `SavedFilter`.
- Chat: `Conversation`, `ConversationMember`, `Message` (per-conversation `seq`), `MessageReaction`, `MessageMention`, `MessageCardRef`.
- Cleanup: `FileDeletion` (outbox of stored files to delete, filled by account deletion and cleanup triggers).
- Billing config: `AppSettings` (one row: billing mode, grace days, maintenance message), `PlanLimit`.
- Rules: `workspace_id` in every `where`; not a member or missing means 404; keyset paging only.

## 6. Permissions, roles, entitlements
- Two layers. (a) Platform permissions (`src/server/permissions.ts` `CATALOGUE`): `site:workspace:read` (admin, audited), and owner-only `site:billing:manage`, `site:plans:manage`, `site:maintenance:manage`, plus core ones (users, roles). Gate with `requirePermission`, never on a role slug. (b) Workspace roles (`workspaces.ts`): viewer < member < admin < owner; nobody can grant `owner` (use transfer); the last owner cannot leave. Board access can be overridden per board (`BoardMember`) and boards can be private.
- Entitlements (`entitlements.ts`): `getEntitlements(db, workspaceId)` is the only reader of `plan_limits`, `app_settings` and `workspaces.plan`. Billing mode `PAID` (default, per HANDOFF) enforces plan limits; `FREE_FOR_ALL` unlocks everything with only safety caps (500 members, 100 MB per file, 200 GB, 200 flows). Over a limit: grace until `grace_until` (default `grace_days` 14), then READ-ONLY (writes refused, reads work). It heals itself under the limit; nothing is deleted. Safety cap of 500 live cards per lane.
- Seeded plans: free 10 members / 10 MB file / 1 GB; pro 50 / 100 MB / 20 GB (`pro-monthly`); team 100 / 100 MB / 100 GB, audit log (`team-monthly`). Owner edits them in `/dashboard` Plan limits.

## 7. Billing (sandbox only, no real money)
- Flow: Billing screen (`/app` settings or `/dashboard/billing`) > `POST /site-api/workspaces/:id/billing/checkout` (admin of that workspace; price from `plan_limits.price_key_monthly`, `customerRef` = `userId:workspaceId`) > platform checkout page (`/checkout/?id=`) > the platform's signed membership event calls `onMembershipChanged` > `applyWorkspacePlan` sets `workspaces.plan` and starts grace if the new plan is smaller. Nightly `plan-sweep` is the backstop for ended subscriptions.
- Owner steps: (1) create sandbox prices `npm run platform -- prices add --key pro-monthly ...` and `--key team-monthly ...` (see `docs/agent/payments.md`); until both exist, billing shows "Payments are not set up yet" and checkout answers 404 `e_price_not_found`. (2) Turn on Storage and a Storage pack (uploads answer `E_STORAGE_NEEDS_PACK` before). (3) Set `SITE_OWNER_EMAILS` so the owner account exists. (4) Move the owner's own test workspace to Team via the sandbox checkout. Show `TestModeBadge` wherever checkout appears. Going live later = connect a gateway.

## 8. Background jobs (`background.json`; wired in `src/server/background.ts`, handlers in `src/server/jobs/`)
| Job | Schedule (UTC) | What |
|---|---|---|
| `plan-sweep` | daily 04:00 | Workspaces whose paid membership ended go back to `free`. |
| `grace-sweep` | daily 04:20 | Start or clear over-limit grace periods. |
| `old-data-cleanup` | daily 04:40, data `{inviteDays: 30, notificationDays: 90}` | Delete old invites, join links, read notifications. |
| `file-cleanup` | hourly (`src/server/jobs/files.ts`) | Delete stored files listed in the `file_deletions` outbox (filled by account deletion and workspace/card cleanup triggers). |
| `invite-emails` | not scheduled; sent by the invite routes (`src/server/jobs/invite-email.ts`) | Email workspace invites. One job per create or resend carries at most 5 invites; retries 4, concurrency 2. |
The four scheduled lists have retries 3 and concurrency 1; handlers are idempotent and keyset-paged (100 per page, max 40 pages; deletes 500 per batch, max 20 batches). Check with `npm run platform -- jobs`.

## 8b. Invite emails (Phase 11; optional, links always work)
- Creating an invite (`POST /workspaces/:id/invites`) may carry `email` and `sendEmail`. The invite row is marked `queued`, a sealed job payload (address and token encrypted with the site secret, bound to the inviter; nothing readable in the Jobs tab) is sent to the `invite-emails` list, and the handler sends through `src/server/mail/send.ts`. The address is never stored in our tables (only a keyed hash on the row binds the invite to it) and never logged.
- Status on the invite row: `queued`, `sent`, `failed`, `not_configured`, or NULL when no email was asked for. 5xx, 429 and timeouts retry; a 4xx marks `failed` at once; missing secrets mark `not_configured` and stop. The provider gets an `Idempotency-Key`.
- Resend: `POST /workspaces/:id/invites/:inviteId/email` (only for a failed or not-set-up invite; the admin types the address again; the token rotates so the old link stops working; at most 5 sends per invite).
- Limits per hour: 30 invite emails per workspace, 10 per inviter (counted on the invite rows).
- Needs the owner secrets `RESEND_API_KEY` and `MAIL_FROM` (`config.ownerSecret`). Without them, or in the editor Preview, the inviter sees an email preview (not sent) in the invite dialog.

## 9. Polling (no WebSockets) and its cost
| What | Interval | Route |
|---|---|---|
| Board sync (`use-board-sync.ts`) | about 5 s, only visible tab; backs off to 60 s on errors; jitter | `GET /boards/:id/rev` (cheap read), then `/changes` only if it moved |
| Chat pulse (`chat/api.ts`) | about 3 s with a chat open and active, 12 s after 60 s idle, 30 s otherwise or on error; hidden tab pauses | `GET /chat/pulse` |
| Notification bell | 30 s, visible tab, refetch on focus | `GET /notifications/unread-count` |
Review estimate (review-performance.md): a user with a board and chat open costs about 40 to 45 queries per minute, linear in users; no ETag/304 anywhere.

## 10. Publish flow (from `docs/agent/publishing.md`)
The OWNER publishes from the editor (agents cannot). Prepare, Build (`npm ci`, `npm run build`), Migrate (pending migrations on the live Site Database; a failure keeps the old version live; destructive SQL waits for approval), Deploy, Live. Rollback = redeploy an earlier deployment (migrations stay applied, so keep them backward-compatible). Before saying done: `npm run build`, `npm test` (with `TEST_DATABASE_URL`), Preview check, `review.md`. Never edit `wrangler` config, never commit `.env`.

## 11. Known gaps and open decisions
The review docs (section 12) hold the findings; the owner's decision list (12 items with recommended answers) is in `owner-actions.md`. Re-checked in code: SEC1 (private board creator) and SEC2 (chat in read-only workspace) are fixed. Now done: `pg_trgm` trigram indexes (guarded migration), workspace archive/restore (owner only, no hard delete), account deletion cleanup (foreign keys, triggers, `file_deletions` outbox, blocked codes `last_workspace_owner`, `paid_workspace`, `workspace_needs_action`), `/jobs` removed. Also done: the account-deletion preflight (`GET /site-api/account/delete-preflight`, screen at `/app/settings/account`), Trello import and JSON/CSV board export (`routes/import-export.ts`, `/app/settings/import-export`), invite emails (section 8b). Still open: browser QA never done, polling has no ETag, Plus Jakarta Sans not adopted (Inter is used).

## 11b. Added 2026-11-04 (checked in code)
- Public board `GET /site-api/public/boards/:token` (`routes/public-board.ts`) and page `/b/<token>/`; owner-side link routes are not built yet (`routes/board-share.ts` missing).
- Notification emails: list `notification-emails`, schedule every 15 minutes, `GET/PATCH /site-api/notification-email`, settings screen `settings/notifications.tsx`; needs `RESEND_API_KEY` and `MAIL_FROM`; off per person by default.
- Board sync polls at 5 s, then 10 s after about 12 unchanged polls and 15 s after about 40 (`idleBaseMs`).

## 12. Docs index (`docs/product/`)
| File | Purpose |
|---|---|
| `SPEC.md`, `HANDOFF.md`, `visual-identity.md` | What to build; later decisions (win over SPEC); look and feel |
| `STATUS.md`, `owner-actions.md`, `RUNBOOK.md` | Phase status; owner steps and open decisions; this runbook |
| `QA-CHECKLIST.md` | Manual click-through script for the owner in the browser |
| `ux-audit.md` | UX audit from code: top 15 fixes by impact and effort |
| `a11y-audit.md` | WCAG 2.2 AA audit from code |
| `responsive-audit.md` | Static responsive audit: top 10 layout problems (safe areas, 100vh) |
| `review-security.md` | Security review round 1, authorization first |
| `review-security-2.md` | Security review round 2 (later additions, open redirect, notification cap) |
| `review-privacy.md` | Privacy audit: delete-account gap, masked-email domain leak |
| `review-performance.md` | Performance review: card move lock, polling, search index, proposed SQL |
| `review-correctness-server.md` | Server correctness review, top 10 |
| `review-correctness-client.md` | Client correctness review, top 10 |
| `review-rules-compliance.md` | AGENTS.md hard-rule sweep |
| `review-production-readiness.md` | Go-live blockers, should-fix, owner actions |
| `review-query-plans.md` | Query plan review (indexes proposed, search and hot reads) |
| `review-security-3.md`, `review-correctness-server-2.md`, `review-correctness-client-2.md`, `a11y-audit-2.md` | Later review rounds |
| `review-merge-damage.md` | Check of damage from merged parallel work |
| `ARCHITECTURE.md`, `CHANGELOG.md` | Engineer map of the code; what exists today, by area |
| `review-security-5-boards.md`, `-chat.md`, `-members.md`, `review-performance-4.md`, `QA-static-findings.md` | Security round 5 (authorization first), performance round 4, static QA trace of `src/app` (2026-11-03) |
| `i18n-qa.md` | QA of the 19 machine-translated catalogs |
| `copy-audit.md` | Copy audit: claims the product cannot back, wording |
| `delete-account-design.md` | Design (no code) for account deletion, with 5 owner questions |
