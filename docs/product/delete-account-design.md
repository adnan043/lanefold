# Delete account: design (no code written)

Fixes `review-privacy.md` P1 (and the `orders.email` part of P2). The platform route
`POST /site-api/auth/delete-account` (`src/platform/auth/security-routes.ts:466`, managed) runs only
`db.user.delete`. We cannot edit it, so the whole fix is: (1) a migration that adds real foreign keys plus
two small triggers, (2) an app-side preflight route the settings screen calls first, (3) a background job
that deletes files afterwards.

## 1. Options

| Option | What | Verdict |
| --- | --- | --- |
| A. FKs only (CASCADE / SET NULL) | DB does the work inside the platform's own `DELETE FROM users` | Necessary, not enough: no last-owner guard, stale `member_count`, no file cleanup |
| B. App-side `deleteUserData()` before the platform call | A wrapper route that cleans up, then calls the platform route | Weak: the platform route stays callable directly (any signed-in client), bypassing it |
| C. A + trigger guard + preflight route + file outbox job (RECOMMENDED) | The DB enforces the rules on every path; the app only makes them friendly | Chosen |

Why DB enforcement: the platform route is reachable by any signed-in browser with a password, so only a
constraint or trigger on `users` is a real guarantee. The preflight route is UX (lists what blocks, lets
the user fix it); the trigger is the backstop (it raises, the platform route answers 500, nothing is lost).

## 2. Every user-id column and its decision

Rule: purely personal rows CASCADE; authored content that other people rely on is kept with the author set
to NULL (UI shows "Deleted user"); nothing is RESTRICT (RESTRICT would give an unreadable 500 from the
platform route; the sole-owner rule is a trigger with a clear message instead).

| Table.column | Now | Decision | Needs nullable? |
| --- | --- | --- | --- |
| user_profiles.user_id | Int unique | CASCADE | no |
| workspace_members.user_id | PK part | CASCADE (+ count fix, section 4) | no |
| board_members.user_id | PK part | CASCADE | no |
| board_stars.user_id | PK part | CASCADE | no |
| card_members.user_id | PK part | CASCADE (assignment disappears) | no |
| card_watchers.user_id | PK part | CASCADE | no |
| comment_mentions.user_id | PK part | CASCADE | no |
| conversation_members.user_id | PK part | CASCADE (DM with a deleted user becomes a one-member DM, see 6) | no |
| message_reactions.user_id | PK part | CASCADE | no |
| message_mentions.user_id | PK part | CASCADE | no |
| notifications.user_id | NOT NULL | CASCADE (the inbox is personal) | no |
| saved_filters.user_id | NOT NULL | CASCADE | no |
| notifications.actor_id | Int? | SET NULL ("Someone") | already |
| comments.author_id | NOT NULL | SET NULL, kept | YES |
| messages.sender_id | NOT NULL | SET NULL, kept | YES |
| activity.actor_id | NOT NULL | SET NULL, kept | YES |
| cards.created_by | NOT NULL | SET NULL | YES |
| boards.created_by | NOT NULL | SET NULL | YES |
| conversations.created_by | NOT NULL | SET NULL | YES |
| workspaces.created_by | NOT NULL | SET NULL (ownership is `workspace_members.role`, not this) | YES |
| workspace_invites.created_by | NOT NULL | SET NULL (open invites keep working) | YES |
| workspace_join_links.created_by | NOT NULL | SET NULL | YES |
| attachments.uploaded_by | NOT NULL | SET NULL, file kept (decision Q3) | YES |
| orders.user_id | Int? | SET NULL, and null `orders.email` (trigger) | already |
| memberships.user_id | Int? | SET NULL, and null `memberships.email`; subscription stays on the workspace | already |
| jobs.created_by (template table) | NOT NULL | leave as is (no FK); mention in the report | no |
| audit_events.actor_user_id | Int?, no FK, managed | leave (a log; ids only, no PII) | no |

Prisma side (done in the implementation task, not now): `Int` becomes `Int?`, plus `user User? @relation(
..., onDelete: SetNull)` or Cascade on each. The managed `User` model must not be edited, so declare the
FKs in migration SQL only and keep the Prisma fields plain `Int`/`Int?` with no relation (same as `jobs`
today). Then `prisma migrate dev` will not try to drop them (it ignores constraints it does not model only if
there is no drift check on FKs: verify with `migrate diff` before shipping; if it complains, model the
relation on the Lanefold side with `@relation(fields:[x], references:[id])` pointing at `User`, which adds
back-relation fields to `User` and needs a platform-upgrade note).

## 3. The one migration (additive, then constraining)

File name when implemented: `prisma/migrations/<ts>_user_fks_and_delete_guards/migration.sql`. One
transaction (`BEGIN; ... COMMIT;`). Order matters: drop NOT NULL, clean orphans, add FKs `NOT VALID`,
`VALIDATE`, then triggers.

```sql
BEGIN;

-- 3.1 Additive: authored columns become nullable.
ALTER TABLE "comments"             ALTER COLUMN "author_id"   DROP NOT NULL;
ALTER TABLE "messages"             ALTER COLUMN "sender_id"   DROP NOT NULL;
ALTER TABLE "activity"             ALTER COLUMN "actor_id"    DROP NOT NULL;
ALTER TABLE "cards"                ALTER COLUMN "created_by"  DROP NOT NULL;
ALTER TABLE "boards"               ALTER COLUMN "created_by"  DROP NOT NULL;
ALTER TABLE "conversations"        ALTER COLUMN "created_by"  DROP NOT NULL;
ALTER TABLE "workspaces"           ALTER COLUMN "created_by"  DROP NOT NULL;
ALTER TABLE "workspace_invites"    ALTER COLUMN "created_by"  DROP NOT NULL;
ALTER TABLE "workspace_join_links" ALTER COLUMN "created_by"  DROP NOT NULL;
ALTER TABLE "attachments"          ALTER COLUMN "uploaded_by" DROP NOT NULL;

-- 3.2 Orphan cleanup (rows whose user is already gone). Personal rows are deleted, authored rows nulled.
DELETE FROM "user_profiles"       t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "workspace_members"   t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "board_members"       t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "board_stars"         t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "card_members"        t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "card_watchers"       t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "comment_mentions"    t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "conversation_members" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "message_reactions"   t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "message_mentions"    t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "notifications"       t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "saved_filters"       t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");

UPDATE "notifications"        t SET "actor_id"    = NULL WHERE "actor_id"    IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."actor_id");
UPDATE "comments"             t SET "author_id"   = NULL WHERE "author_id"   IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."author_id");
UPDATE "messages"             t SET "sender_id"   = NULL WHERE "sender_id"   IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."sender_id");
UPDATE "activity"             t SET "actor_id"    = NULL WHERE "actor_id"    IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."actor_id");
UPDATE "cards"                t SET "created_by"  = NULL WHERE "created_by"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "boards"               t SET "created_by"  = NULL WHERE "created_by"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "conversations"        t SET "created_by"  = NULL WHERE "created_by"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "workspaces"           t SET "created_by"  = NULL WHERE "created_by"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "workspace_invites"    t SET "created_by"  = NULL WHERE "created_by"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "workspace_join_links" t SET "created_by"  = NULL WHERE "created_by"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "attachments"          t SET "uploaded_by" = NULL WHERE "uploaded_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."uploaded_by");
UPDATE "orders"               t SET "user_id"     = NULL, "email" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
UPDATE "memberships"          t SET "user_id"     = NULL, "email" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");

-- Recompute every workspace count once (fixes already-stale counters).
UPDATE "workspaces" w SET "member_count" = (SELECT count(*) FROM "workspace_members" m WHERE m."workspace_id" = w.id);

-- 3.3 Foreign keys. NOT VALID first (instant, no full scan under a strong lock), then VALIDATE
-- (scans, takes only SHARE UPDATE EXCLUSIVE, does not block writes).
-- CASCADE (personal):
ALTER TABLE "user_profiles"        ADD CONSTRAINT "user_profiles_user_id_fkey"        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "workspace_members"    ADD CONSTRAINT "workspace_members_user_id_fkey"    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "board_members"        ADD CONSTRAINT "board_members_user_id_fkey"        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "board_stars"          ADD CONSTRAINT "board_stars_user_id_fkey"          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "card_members"         ADD CONSTRAINT "card_members_user_id_fkey"         FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "card_watchers"        ADD CONSTRAINT "card_watchers_user_id_fkey"        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "comment_mentions"     ADD CONSTRAINT "comment_mentions_user_id_fkey"     FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "message_reactions"    ADD CONSTRAINT "message_reactions_user_id_fkey"    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "message_mentions"     ADD CONSTRAINT "message_mentions_user_id_fkey"     FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "notifications"        ADD CONSTRAINT "notifications_user_id_fkey"        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "saved_filters"        ADD CONSTRAINT "saved_filters_user_id_fkey"        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
-- SET NULL (authored / history):
ALTER TABLE "notifications"        ADD CONSTRAINT "notifications_actor_id_fkey"       FOREIGN KEY ("actor_id")    REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "comments"             ADD CONSTRAINT "comments_author_id_fkey"           FOREIGN KEY ("author_id")   REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "messages"             ADD CONSTRAINT "messages_sender_id_fkey"           FOREIGN KEY ("sender_id")   REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "activity"             ADD CONSTRAINT "activity_actor_id_fkey"            FOREIGN KEY ("actor_id")    REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "cards"                ADD CONSTRAINT "cards_created_by_fkey"             FOREIGN KEY ("created_by")  REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "boards"               ADD CONSTRAINT "boards_created_by_fkey"            FOREIGN KEY ("created_by")  REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "conversations"        ADD CONSTRAINT "conversations_created_by_fkey"     FOREIGN KEY ("created_by")  REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "workspaces"           ADD CONSTRAINT "workspaces_created_by_fkey"        FOREIGN KEY ("created_by")  REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "workspace_invites"    ADD CONSTRAINT "workspace_invites_created_by_fkey" FOREIGN KEY ("created_by")  REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "workspace_join_links" ADD CONSTRAINT "workspace_join_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "attachments"          ADD CONSTRAINT "attachments_uploaded_by_fkey"      FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "orders"               ADD CONSTRAINT "orders_user_id_fkey"               FOREIGN KEY ("user_id")     REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "memberships"          ADD CONSTRAINT "memberships_user_id_fkey"          FOREIGN KEY ("user_id")     REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;

-- VALIDATE each constraint above (one statement per constraint; same names), e.g.:
ALTER TABLE "user_profiles" VALIDATE CONSTRAINT "user_profiles_user_id_fkey";
-- ... repeat for all 25.

-- 3.4 FK support indexes. Cascade/SET NULL scans the child by the FK column on every delete.
-- Already covered (user_id leads an index): workspace_members, board_members, card_members, card_watchers,
-- comment_mentions, conversation_members, message_mentions, notifications, saved_filters, comments(author_id),
-- messages(sender_id), attachments(uploaded_by), orders, memberships. board_stars PK is (user_id, board_id): ok.
-- MISSING, add (prefer CREATE INDEX CONCURRENTLY outside the transaction in a second migration if tables are big):
CREATE INDEX "user_profiles_user_id_key_dummy" ON "user_profiles"("user_id") ;  -- NOT needed: user_id is UNIQUE already. Skip.
CREATE INDEX "message_reactions_user_id_idx"    ON "message_reactions"("user_id");
CREATE INDEX "activity_actor_id_idx"            ON "activity"("actor_id") WHERE "actor_id" IS NOT NULL;
CREATE INDEX "cards_created_by_idx"             ON "cards"("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX "boards_created_by_idx"            ON "boards"("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX "conversations_created_by_idx"     ON "conversations"("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX "workspaces_created_by_idx"        ON "workspaces"("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX "workspace_invites_created_by_idx" ON "workspace_invites"("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX "workspace_join_links_created_by_idx" ON "workspace_join_links"("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX "notifications_actor_id_idx"       ON "notifications"("actor_id") WHERE "actor_id" IS NOT NULL;
-- (Drop the "_dummy" line when writing the real file; it is a reminder that unique columns need no index.)
-- Partial indexes keep them tiny; Prisma schema must declare them or migrate dev will see drift: use plain
-- @@index([createdBy]) in schema.prisma (a non-partial index) to stay drift-free, and make the SQL match.

-- 3.5 File outbox (section 5).
CREATE TABLE "file_deletions" (
  "id"         BIGSERIAL PRIMARY KEY,
  "file_id"    VARCHAR(32) NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "done_at"    TIMESTAMPTZ(3)
);
CREATE INDEX "file_deletions_pending_idx" ON "file_deletions"("id") WHERE "done_at" IS NULL;

-- 3.6 The guard + bookkeeping trigger. BEFORE DELETE runs before the FK cascades remove the member rows,
-- in the same transaction as the platform's DELETE FROM users.
CREATE FUNCTION lanefold_before_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocked INTEGER;
BEGIN
  -- Serialise concurrent deletions of co-owners: lock the affected workspace rows first.
  PERFORM 1 FROM "workspaces" w
   WHERE w.id IN (SELECT workspace_id FROM "workspace_members" WHERE user_id = OLD.id AND role = 'owner')
   ORDER BY w.id FOR UPDATE;

  SELECT count(*) INTO blocked FROM "workspace_members" me
   WHERE me.user_id = OLD.id AND me.role = 'owner'
     AND NOT EXISTS (SELECT 1 FROM "workspace_members" o
                      WHERE o.workspace_id = me.workspace_id AND o.role = 'owner' AND o.user_id <> OLD.id);
  IF blocked > 0 THEN
    RAISE EXCEPTION 'last_workspace_owner: transfer or delete % workspace(s) first', blocked
      USING ERRCODE = 'P0001';
  END IF;

  -- Seats: one decrement per workspace the user is in (before the cascade removes the rows).
  UPDATE "workspaces" w SET "member_count" = GREATEST(w."member_count" - 1, 0)
    FROM "workspace_members" m WHERE m.user_id = OLD.id AND m.workspace_id = w.id;

  -- Uploads: only needed if decision Q3 = "delete their uploads" (see 5). Otherwise omit.
  -- Privacy: drop the buyer's email, keep the order.
  UPDATE "orders"      SET "email" = NULL WHERE "user_id" = OLD.id;
  UPDATE "memberships" SET "email" = NULL WHERE "user_id" = OLD.id;
  RETURN OLD;
END $$;

CREATE TRIGGER lanefold_before_user_delete BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION lanefold_before_user_delete();

COMMIT;
```

Notes on the SQL:
- Cleanup of orphans is idempotent and runs inside the same transaction; run it first as a read-only count in
  staging (`SELECT count(*)` with the same `NOT EXISTS`) to see how many rows it will touch.
- Prisma will see the triggers/FKs as drift only if it models them; triggers are never modelled. Run
  `prisma migrate diff --from-migrations ... --to-schema-datamodel` before shipping.
- Trigger on `users` (a managed table): it is a migration on a managed table, but it adds no column and
  survives `platform upgrade` unless the upgrade recreates the table (it does not; migrations are additive).
  Tell the owner it exists; keep a test that fails if it is gone.
- The `memberships.email` / `orders.email` null is also done at SET NULL time by the trigger, because an
  FK cannot null two columns.

## 4. Last workspace owner

Three layers.
1. Preflight route (UX): `POST /site-api/account/delete-preflight`, guards `validator -> withViewer ->
   requireAuth -> withDb`, no body. Returns `{canDelete, blockingWorkspaces: [{id, name, memberCount,
   otherMembers: [{id, name, role}] }], willDelete: {boards..., }}`. Query (one raw statement, prepared):
   workspaces where the viewer is `owner` and no other `owner` exists (the same `NOT EXISTS` as the
   trigger). `viewer.id` only from the session, never the body. Rate limited (cheap, but it is a read of
   workspace membership names; the names are of members of workspaces the user is in).
2. Settings screen "Delete account": calls preflight first. If `blockingWorkspaces` is non-empty the
   confirmation form is replaced by a list: per workspace, "Make <member> owner" (existing role-change
   route) or "Delete workspace" (existing delete flow with its own confirm), then "Check again". Delete
   button stays disabled until `canDelete`. Only then the existing platform form (password + DELETE).
3. Trigger (backstop, section 3.6): raises `P0001`. The platform route would answer a generic 500; add a
   Lanefold `onError` mapping is not possible inside the managed route, so we accept the 500 as the
   backstop only (nobody reaches it from the UI).
   If we later want a friendly message, wrap: the settings form posts to OUR route
   `POST /site-api/account/delete` that runs the preflight check, then calls the platform handler logic via
   an in-process `fetch`/internal call. This is optional (decision Q1).

Why not "sole owner with other members: auto-promote someone"? Silently handing ownership and billing to a
person the owner did not pick is wrong. Sole owner and nobody else in the workspace: offer "Delete
workspace" (it cascades all its data through existing workspace_id FKs; verify that workspace delete exists,
if not it is a prerequisite).

## 5. Files

Today the app stores a file id only in `attachments.file_id`, `cards.cover_file_id` and `boards.bg_file_id`;
there are no avatars. Policy (Q3): files are workspace content, kept with `uploaded_by = NULL`, so nothing to
delete by default. Files are deleted when their row is deleted (card/workspace delete), and that path needs
the same outbox to avoid orphans. Design:
- Outbox table `file_deletions` (3.5), filled by `AFTER DELETE ON attachments` trigger
  (`INSERT ... ON CONFLICT DO NOTHING` of `OLD.file_id` when not null) plus the existing app code paths that
  clear `cover_file_id` / `bg_file_id`. Cascade deletes (card, workspace) go through the trigger, so
  nothing is missed.
- If the owner chooses "delete the user's uploads too" (Q3 = yes): in `lanefold_before_user_delete` add
  `INSERT INTO file_deletions(file_id) SELECT file_id FROM attachments WHERE uploaded_by = OLD.id AND file_id IS NOT NULL ON CONFLICT DO NOTHING;`
  then `DELETE FROM attachments WHERE uploaded_by = OLD.id;` (and null a card cover that points at them).
- Background job `file-cleanup` (`src/server/background.ts`, schedule every 10 min in `background.json`,
  also `sendJob()` once after a deletion is not possible from the platform route: the schedule covers it).
  Handler: select up to 50 rows `WHERE done_at IS NULL ORDER BY id` (keyset), call
  `deleteFile(requestUrl, id)` (`src/platform/files.ts:142`) with its timeout, treat 404 as done, set
  `done_at` on success, leave on failure (retry next run; give up and log by id after 20 tries via an
  `attempts` column if wanted), and `DELETE` rows done more than 7 days ago. Idempotent by design.
- `storage_used_bytes`: the same trigger should subtract `OLD.size` from the workspace
  (`UPDATE workspaces SET storage_used_bytes = GREATEST(storage_used_bytes - OLD.size,0)`); check how the
  app currently maintains it, to avoid double counting (same caveat as member_count).

## 6. Stale counters

`workspaces.member_count` is maintained by app code (`members.ts:118`, `:462`, conditional increment under a
limit). A general `AFTER INSERT/DELETE ON workspace_members` trigger would double count with that code.
Recommended: the narrow `BEFORE DELETE ON users` decrement in 3.6 (only fires on account deletion), plus the
one-time recompute in 3.2. Safety net: a scheduled job `recount-members` (daily) that fixes drift with
`UPDATE workspaces w SET member_count = c.n FROM (SELECT workspace_id, count(*) n FROM workspace_members GROUP BY 1) c WHERE c.workspace_id = w.id AND w.member_count <> c.n`
(plus workspaces with zero members set to 0). Bounded by `WHERE member_count <> n`, no per-row loop.
Also: `cards`/`conversation` counters derived from deleted membership (e.g. `lastSeq`) are unaffected.
A DM whose only other member is deleted stays as a read-only conversation with one member; the UI should
disable the composer when `dmKey` points at a missing user (the other id is not in `conversation_members`).

## 7. Risk, locks, time, rollback

- Locks: `ALTER COLUMN DROP NOT NULL` and `ADD CONSTRAINT ... NOT VALID` take a short ACCESS EXCLUSIVE /
  SHARE ROW EXCLUSIVE on each table, metadata only (milliseconds). `VALIDATE CONSTRAINT` scans with
  SHARE UPDATE EXCLUSIVE (writes continue). `CREATE INDEX` (non-concurrent) blocks writes for the build;
  at MVP volumes (assume under 1M rows per table) it is seconds. If `activity`/`messages` are large, split
  the indexes into a second migration using `CREATE INDEX CONCURRENTLY` (cannot run inside a transaction).
- The orphan `UPDATE`s rewrite rows: bounded by the number of already-deleted users' rows (likely zero to a
  few hundred, because delete-account is new). Estimate total migration: under 10 s on a dev-sized DB,
  under 1 min at 1M rows. Take a snapshot/backup first (Prisma Postgres PITR) and run in a quiet window.
- Rollback: the migration is one transaction, so a failure leaves nothing. After it has committed, rollback
  is a second migration: `DROP TRIGGER lanefold_before_user_delete ON users; DROP FUNCTION ...;` then
  `ALTER TABLE ... DROP CONSTRAINT <name>` for the 25 constraints, drop the indexes and `file_deletions`.
  Do NOT restore NOT NULL (rows with NULL authors would violate it). Data cleanup (orphan delete/null) is not
  reversible, hence the backup and the dry-run counts.
- Code deploy order: (1) deploy code that tolerates NULL authors (`?? 'Deleted user'`) FIRST (harmless
  before the migration), (2) then run the migration. Never the reverse, or the UI crashes on a NULL sender.

## 8. UI effects (all authored content, author null)

Server rule: every route that returns an author maps `null` (and a user id with no `users` row, from rows
that were not backfilled) to `{id: null, name: 'Deleted user', avatar: null}`; no email, never a link to a
profile. The client renders a neutral grey avatar with a generic person glyph, name in `--muted`.
- Chat: message sender "Deleted user"; no reply-to-profile, no DM button; the composer in a DM whose peer is
  gone is disabled with "This person deleted their account." Reactions of the deleted user vanish (cascade),
  so counts drop by one.
- Cards: `created_by` null is shown as "Deleted user" in details/activity; assignees and watchers vanish
  (cascade), so a card may become unassigned. Board and workspace creator is not displayed as owner anyway.
- Comments: author "Deleted user", body kept, edit/delete only for admins (the own-comment check `authorId
  === me` is false for null: verify `null !== me` never allows an edit).
- Mentions of the deleted user inside text bodies: the `@name` text stays (it is content); the
  `comment_mentions`/`message_mentions` rows go. Render stale mention chips as plain text.
- Member lists: row removed (cascade); counts decrease via the trigger.
- Notifications: the deleted user's inbox disappears; other people's notifications with that actor show
  "Someone" (`actor_id` null).
- Activity feed: "Deleted user moved card X to Done"; `activity.meta` titles stay (content, not PII).
- Invites and join links created by them keep working; the "created by" column shows "Deleted user".
- Types: client `Author` types become `{id: number | null, ...}`; sorting/grouping by sender id must treat
  null as its own group. Search by author must ignore null.

## 9. Integration tests to write (`tests/integration/delete-account.test.ts`, need `TEST_DATABASE_URL`)

Use the repo's helpers to make users and a workspace, then call the platform `POST /site-api/auth/delete-account`
with password + `DELETE` (that is the real path).
1. Personal rows cascade: user with profile, workspace_members, board_members, board_stars, card_members,
   card_watchers, saved_filters, notifications (as recipient), conversation_members, reactions, mentions ->
   after delete every table has zero rows for that id.
2. Authored rows survive with NULL: comment, message, activity, card/board/conversation/workspace
   `created_by`, invite, join link, attachment: row present, author column NULL, other user's reads show
   "Deleted user" and 200 (not 500).
3. Notification where the deleted user is the actor survives with `actor_id` NULL.
4. Sole owner blocked: user is only `owner` of workspace W with another member -> delete returns non-2xx,
   user row still exists, no rows changed (transaction rolled back), W intact. Preflight lists W.
5. Co-owner allowed: W has two owners -> one deletes OK; W has one owner left; `member_count` decreased by 1.
6. Race: two co-owners deleted concurrently (`Promise.all`) -> exactly one succeeds, the other is blocked.
7. Preflight authorization: unauthenticated 401; user B never sees workspaces they do not own (404-style
   empty list); body ignored (cannot pass another user id); result matches trigger decision exactly.
8. member_count: workspace with 3 members, delete one -> 2 and equals `count(*)` of members; the recount job
   fixes a deliberately skewed counter and leaves correct ones untouched.
9. Orders: order and membership rows kept, `user_id` and `email` NULL.
10. Files: attachment rows deleted (card delete or Q3=yes path) enqueue `file_deletions`; the job handler,
    with `deleteFile` stubbed, marks done, treats 404 as done, retries a failing id, is idempotent when run
    twice.
11. Migration: on a DB seeded with orphan rows (dead ids in every table), the cleanup SQL leaves zero
    violations and the FKs validate; `SELECT convalidated` is true for all 25 constraints; the trigger exists.
12. Other users' data untouched: a second user's rows in the same workspace are identical before/after.

## 10. Decisions for the owner (recommended answers)

1. Should a person who is the only owner of a workspace be blocked from deleting their account until they
   transfer ownership or delete the workspace?
   Recommended: YES, block, with the preflight list and one-click "Make owner" / "Delete workspace".
   (Auto-transfer or auto-delete are both unsafe.)
2. Should messages and comments by a deleted person stay in other people's workspaces as "Deleted user", or
   be erased?
   Recommended: KEEP, anonymised (author NULL). Erasing breaks conversations and threads for everyone else;
   say so in the privacy policy and offer owners a manual "delete this message".
3. Should the deleted person's uploaded files (card attachments, chat files) be deleted too?
   Recommended: KEEP files on shared cards and chats (they are the workspace's records, now anonymous), but
   delete files in DMs where the other side is gone. Simplest to ship first: keep all, and delete files only
   with their card/workspace (through the outbox job).
4. Should paid history stay when an account is deleted?
   Recommended: YES, keep orders and memberships (legal/accounting) but wipe `user_id` and `email`; if the
   person owned a paid workspace they must first transfer or delete it (covered by Q1).
5. Do we need a friendly in-app error for API callers who bypass the preflight, or is a generic error
   acceptable?
   Recommended: ACCEPT generic (the trigger is a backstop; the UI cannot reach it). Revisit by wrapping the
   delete in our own route only if support sees it.

## 11. Order of work for the implementation task

1. Code first: author null handling in server mappers and client types ("Deleted user"), deploy it.
2. Dry-run the orphan counts on the live DB (read-only SQL from 3.2 with `SELECT count(*)`).
3. Migration (3.1 to 3.6), `prisma generate`, schema.prisma edits (`Int?`, indexes).
4. Preflight route + settings screen + tests; `file-cleanup` and `recount-members` jobs + `background.json`.
5. `review.md` pass (authorization on preflight first), `npm run build`, `npm test`, integration tests.
