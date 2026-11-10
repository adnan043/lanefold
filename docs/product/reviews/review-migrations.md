# Migration review for a live Publish

Scope: every folder in `prisma/migrations`, judged against a LIVE database that holds data and has applied only
the template's migrations (`init`, `site_auth`, `seed_roles`, `job_deliveries`, `account_security`,
`sign_in_codes`, `payments`). Everything from `20261102120928_lanefold_mvp` on is new to it.
Read-only review: no migration was edited, nothing was applied.

## Verdict
Safe to apply, in order, one transaction per migration. Two things need an owner decision first (the jobs table
drop, and the orphan cleanup in the account-deletion migration). Nothing needs a code fix.

## Ordering
All 20 folders sort strictly after the previous one (lexicographic = chronological). The seven template
migrations are unmodified in git. `20261102120928_lanefold_mvp` is committed; the 11 later folders are
UNTRACKED in git: commit them with the schema change before Publish or the build will not ship them.

## Per-migration risk

| Migration | Does | Risk | Notes |
| --- | --- | --- | --- |
| 20261019090000_init ... 20261029090000_payments | template | none (already applied) | unchanged |
| 20261102120928_lanefold_mvp | ~45 new tables, indexes, CHECKs, seeds `app_settings` (billing_mode PAID, grace 14 days) and `plan_limits` | low | Only creates; touches no existing table. `ALTER ... position TYPE COLLATE "C"` runs on its own empty new tables. One BEGIN/COMMIT: all or nothing. Not idempotent (plain CREATE), which is fine because it is atomic and Prisma records it once. |
| 20261102124901_cards_board_open_idx | partial index on `cards` | low | Plain CREATE INDEX: blocks writes to `cards` while it builds. Table is new/small. |
| 20261103051050_memberships_workspace_last_event | 2 nullable columns on `memberships`, index | low | Nullable ADD COLUMN is instant. `memberships` is a template (payments) table, small. No FK on `workspace_id` (by design). |
| 20261103053243_query_plan_indexes | 2 indexes (one partial) | low | As above. |
| 20261103083657_drop_job_board | `DROP TABLE "jobs"` | HIGH (data) | See below. |
| 20261103090000_remove_job_permission | deletes permission `site:job:manage`, rewrites Admin role description | low-medium | See below. |
| 20261103100000_search_trigram | optional `pg_trgm` + 4 GIN indexes (cards.title, cards.description_md, boards.name, users.name) | low | See below. |
| 20261103100100_workspace_archive | 2 nullable columns on `workspaces`, partial index | low | Instant. |
| 20261103130000_account_deletion_cleanup | 10 DROP NOT NULL, `file_deletions` table, 3 functions, 5 triggers, orphan data cleanup, 25 FKs to `users`, 9 indexes | MEDIUM | See below. |
| 20261103140000_chat_thread_index | index on `messages` | low | `IF NOT EXISTS`. Plain build blocks chat writes briefly; table is new. |
| 20261103150000_workspace_removals | new table + 2 FKs + index | low | Create only. |
| 20261103160000_invite_email_status | 4 columns on `workspace_invites` (one NOT NULL DEFAULT 0), 2 indexes | low | Constant default: no table rewrite on Postgres 11+. |
| 20261103170000_audit_actor_action_idx | index on `audit_events` | low | `IF NOT EXISTS`. `audit_events` is a template table and the only one that can grow large (sign-in events). A plain index blocks audit writes (i.e. sign-in logging) while it builds: seconds up to ~100k rows. Not worth a CONCURRENTLY migration unless the table holds millions. |

## Destructive steps

### 20261103083657_drop_job_board: `DROP TABLE "jobs"`
- Drops exactly one table, `jobs` (template job board, created in `init`), with its two indexes. Prisma's own
  warning is in the file: all rows are lost.
- Nothing references it: no FK points to `jobs` (its `created_by` never had one) and no later migration or view
  uses it. `job_deliveries` is the background-job replay guard and is NOT touched (different table).
- The routes, pages and screen for jobs are already deleted in the working tree, so after Publish the data is
  also unreachable. No backup is taken by the migration.
- Owner action: if the live site ever had jobs posted, export them first. Check with a row count on the live
  `jobs` table (Prisma Studio) before approving. If it is empty or only template samples, nothing is lost.

### 20261103090000_remove_job_permission
- `DELETE FROM permissions WHERE codename = 'site:job:manage'`. `role_permissions` has an FK with ON DELETE
  CASCADE, so grants to roles (Admin, custom roles) disappear with it. No user loses any other permission.
- The `UPDATE roles` only changes the description of the system Admin role, and only if it still has the
  original template text (an owner-edited description is left alone). Idempotent.
- The codename is gone from `src/server/permissions.ts`, so it is not re-created at runtime. Verified: no
  reference to `site:job` in `src` or `tests` outside the managed `src/platform` comments.

### 20261103130000_account_deletion_cleanup (data-changing parts)
- Step 3 DELETES data that is already dangling: orphan Inbox boards (and their cards, via FK cascade),
  personal rows of users that no longer exist, and every workspace with ZERO members (with its conversations,
  activity, notifications, attachments). On a live site that already ran the earlier migrations this only
  removes leftovers of deleted accounts, but a workspace with no member rows is deleted whatever its content,
  archived ones included. File ids of deleted attachments/covers/backgrounds go to `file_deletions`, so their
  stored bytes are removed later by the `file-cleanup` job (also irreversible).
  Owner action: before Publish, count workspaces with no members (and orphan rows) on live; expect 0 or a few.
- `orders.user_id`/`email` and `memberships.user_id`/`email` are set to NULL for users that no longer exist
  (privacy-by-design; the purchase rows stay).
- Step 3 repairs `workspaces.member_count` for every row that differs (one UPDATE, harmless).

## Lock and performance notes
- Every migration is wrapped in BEGIN/COMMIT (the single-statement `drop_job_board` is atomic by itself), so a
  failure leaves the schema as it was. Prisma records a migration only when it fully succeeds; a failed one
  must be resolved before the next Publish (`migrate resolve`), it is not retried silently.
- 20261103130000 adds 25 FKs to `users`. `ADD CONSTRAINT` takes SHARE ROW EXCLUSIVE on both tables, held to
  COMMIT, so writes to `users` (sign-up, profile edits, delete) wait for the whole migration. They are added
  NOT VALID then validated, after the orphans are removed in the same transaction, so validation cannot fail
  on data that was there at start. Expect seconds on a small site; do not Publish during a sign-up campaign
  if `users` is large.
- The migration creates BEFORE DELETE on `users`. It also changes how the platform's `DELETE FROM users`
  behaves for every path: deleting an account now FAILS with a clear error (`last_workspace_owner`,
  `paid_workspace`, `workspace_needs_action`) when the person owns shared or paid workspaces, or a solo
  workspace with content. That is intended, but the owner/admin "delete user" screen will surface these errors.
  The trigger takes row locks on the person's workspaces in id order (deadlock-safe).
- Functions use plain `CREATE FUNCTION` and triggers plain `CREATE TRIGGER` (no OR REPLACE, no IF NOT EXISTS):
  fine inside the atomic migration, but it cannot be re-run by hand after success.
- GIN trigram builds (`search_trigram`) lock writes on cards/boards/users while building; seconds on small
  tables. `users_name_trgm_idx` is on a managed table.
- pg_trgm guard: the DO block swallows any failure (no extension rights, any index error) with a NOTICE, and the
  migration still succeeds with NO indexes. Search is then correct but un-indexed. Risk is silent: after Publish
  check that the four `*_trgm_idx` indexes exist; if not, allow the extension and create them by hand (the
  statements are `IF NOT EXISTS`). The outer `EXCEPTION WHEN OTHERS` also means a real bug in the index
  statements would be hidden the same way.

## Drift check
Run against `lanefold_test` (host localhost:5480, never `lanefold`), read-only. Note: this Prisma version
removed `--from-url`; used `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
with `DATABASE_URL` set to the test URL.

Result: NOT empty, but all differences are intentional SQL-only objects the schema cannot express:
- 26 foreign keys to `users` (25 from the account-deletion migration plus `workspace_removals_user_id_fkey`):
  the datamodel has no relation to the managed `users` model, so Prisma wants to drop them.
- 4 trigram GIN indexes (`boards_name_trgm_idx`, `cards_description_md_trgm_idx`, `cards_title_trgm_idx`,
  `users_name_trgm_idx`).
- No missing tables, columns, defaults or nullability differences: the test database matches the schema
  otherwise. Partial indexes, CHECKs, functions and triggers are invisible to the diff, so this does not prove
  they exist; the migrations are the source of truth for them.

Consequence for future work: every later `prisma migrate dev --create-only` will propose DROPping those 26 FKs
and 4 indexes. Delete those lines from the generated SQL (as database.md says for partial indexes), or the
next migration silently removes account-deletion integrity and search indexes. Also never "fix" the drift by
adding relations to `users` in `schema.prisma` without a migration plan.

## What the owner should know before approving Publish
1. The job board table is dropped for good. Confirm the live `jobs` table is empty or exported.
2. The account-deletion migration deletes memberless workspaces and rows of already-deleted users, and queues
   their files for permanent deletion. Check the live counts first if there is real data.
3. After Publish, deleting a user can be refused with an explanation (owner of a shared or paid workspace).
4. Search indexes are best-effort: verify they were created.
5. The migrations take brief write locks (users, cards, messages, audit_events): choose a quiet moment.
6. There is no rollback script: back up (snapshot) the live database before Publish.
7. Commit the 11 untracked migration folders together with `prisma/schema.prisma`.

## Fixes needed in migrations
None. Do not edit any migration once applied anywhere; if something is wrong later, add a new migration.
