-- Account deletion cleanup (docs/product/delete-account-design.md, owner answers: recommended).
-- The platform's POST /site-api/auth/delete-account (managed) only runs `DELETE FROM users`, so the rules live in the
-- database and hold on every path: real foreign keys to users, plus a BEFORE DELETE trigger on users.
--   * personal rows (memberships, stars, assignments, inbox, notifications, saved filters, reactions...) CASCADE;
--   * authored content (comments, messages, activity, cards, boards, ...) is kept with the author set to NULL
--     ("Deleted user" in the UI);
--   * the person's personal Inbox board is deleted (with its cards); files go to the file_deletions outbox;
--   * the only owner of a workspace that still has other members is BLOCKED (last_workspace_owner; this includes an
--     archived workspace: the owner must hand it over first);
--     the only member of a free workspace takes it with them ONLY when it is empty (just the default general chat,
--     no cards, no files); otherwise workspace_needs_action; a paid one must be downgraded first (paid_workspace);
--   * removed attachments give their bytes back (storage_used_bytes) in an AFTER DELETE trigger;
--   * orders and memberships stay, with user_id and email wiped.
-- Idempotent where it can be: DROP NOT NULL, orphan cleanup and the recount are safe to repeat.
BEGIN;

-- 1. Authored columns become nullable.
ALTER TABLE "comments" ALTER COLUMN "author_id" DROP NOT NULL;
ALTER TABLE "messages" ALTER COLUMN "sender_id" DROP NOT NULL;
ALTER TABLE "activity" ALTER COLUMN "actor_id" DROP NOT NULL;
ALTER TABLE "cards" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "boards" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "conversations" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "workspaces" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "workspace_invites" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "workspace_join_links" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "uploaded_by" DROP NOT NULL;

-- 2. File outbox: the id of every stored file whose row is deleted; the `file-cleanup` job deletes the bytes.
CREATE TABLE "file_deletions" (
    "id" BIGSERIAL NOT NULL,
    "file_id" VARCHAR(32) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_deletions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "file_deletions_file_id_key" ON "file_deletions"("file_id");
CREATE INDEX "file_deletions_done_at_id_idx" ON "file_deletions"("done_at", "id");

CREATE FUNCTION lanefold_enqueue_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fid text;
BEGIN
  fid := to_jsonb(OLD) ->> TG_ARGV[0];
  IF fid IS NOT NULL AND fid <> '' THEN
    INSERT INTO "file_deletions" ("file_id") VALUES (fid) ON CONFLICT ("file_id") DO NOTHING;
  END IF;
  RETURN OLD;
END $$;

-- Every removed ready attachment gives its bytes back to the workspace (a row delete from any path, including the
-- cascade of a deleted card, board or account). The workspace row may already be gone: then it updates nothing.
CREATE FUNCTION lanefold_attachment_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "workspaces" SET "storage_used_bytes" = GREATEST("storage_used_bytes" - OLD."size", 0) WHERE id = OLD."workspace_id";
  RETURN OLD;
END $$;
CREATE TRIGGER lanefold_attachment_storage AFTER DELETE ON "attachments"
  FOR EACH ROW WHEN (OLD."ready" AND OLD."size" > 0) EXECUTE FUNCTION lanefold_attachment_storage();

CREATE TRIGGER lanefold_attachment_file AFTER DELETE ON "attachments"
  FOR EACH ROW WHEN (OLD."file_id" IS NOT NULL) EXECUTE FUNCTION lanefold_enqueue_file('file_id');
CREATE TRIGGER lanefold_card_cover_file AFTER DELETE ON "cards"
  FOR EACH ROW WHEN (OLD."cover_file_id" IS NOT NULL) EXECUTE FUNCTION lanefold_enqueue_file('cover_file_id');
CREATE TRIGGER lanefold_board_bg_file AFTER DELETE ON "boards"
  FOR EACH ROW WHEN (OLD."bg_file_id" IS NOT NULL) EXECUTE FUNCTION lanefold_enqueue_file('bg_file_id');

-- 3. Orphan cleanup: rows of accounts that are already gone (before this migration deleting left them behind).
-- Orphan Inbox boards: first what hangs off them without a foreign key (as the live trigger does), then the boards.
CREATE TEMP TABLE _orphan_inbox ON COMMIT DROP AS
  SELECT b.id, b.workspace_id FROM "boards" b WHERE b."inbox_of" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = b."inbox_of");
DELETE FROM "conversations" WHERE board_id IN (SELECT id FROM _orphan_inbox);
DELETE FROM "activity" a WHERE a.board_id IN (SELECT id FROM _orphan_inbox)
   OR a.card_id IN (SELECT c.id FROM "cards" c WHERE c.board_id IN (SELECT id FROM _orphan_inbox));
DELETE FROM "card_links" l WHERE l.card_id IN (SELECT c.id FROM "cards" c WHERE c.board_id IN (SELECT id FROM _orphan_inbox))
   OR l.linked_card_id IN (SELECT c.id FROM "cards" c WHERE c.board_id IN (SELECT id FROM _orphan_inbox));
DELETE FROM "notifications" n WHERE n.board_id IN (SELECT id FROM _orphan_inbox)
   OR n.card_id IN (SELECT c.id FROM "cards" c WHERE c.board_id IN (SELECT id FROM _orphan_inbox));
DELETE FROM "boards" WHERE id IN (SELECT id FROM _orphan_inbox);
DELETE FROM "user_profiles" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "workspace_members" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "board_members" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "board_stars" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "card_members" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "card_watchers" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "comment_mentions" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "conversation_members" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "message_reactions" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "message_mentions" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "notifications" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
DELETE FROM "saved_filters" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
-- Workspaces left with no member at all (their last owner was deleted before this migration): gone, with what
-- hangs off them without a foreign key. Files go to the outbox through the attachment trigger.
CREATE TEMP TABLE _orphan_ws ON COMMIT DROP AS
  SELECT w.id FROM "workspaces" w WHERE NOT EXISTS (SELECT 1 FROM "workspace_members" m WHERE m.workspace_id = w.id);
DELETE FROM "conversations" WHERE workspace_id IN (SELECT id FROM _orphan_ws);
DELETE FROM "activity" WHERE workspace_id IN (SELECT id FROM _orphan_ws);
DELETE FROM "card_links" WHERE workspace_id IN (SELECT id FROM _orphan_ws);
DELETE FROM "notifications" WHERE workspace_id IN (SELECT id FROM _orphan_ws);
DELETE FROM "attachments" WHERE workspace_id IN (SELECT id FROM _orphan_ws);
DELETE FROM "workspaces" WHERE id IN (SELECT id FROM _orphan_ws);
UPDATE "notifications" t SET "actor_id" = NULL WHERE "actor_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."actor_id");
UPDATE "comments" t SET "author_id" = NULL WHERE "author_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."author_id");
UPDATE "messages" t SET "sender_id" = NULL WHERE "sender_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."sender_id");
UPDATE "activity" t SET "actor_id" = NULL WHERE "actor_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."actor_id");
UPDATE "cards" t SET "created_by" = NULL WHERE "created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "boards" t SET "created_by" = NULL WHERE "created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "conversations" t SET "created_by" = NULL WHERE "created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "workspaces" t SET "created_by" = NULL WHERE "created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "workspace_invites" t SET "created_by" = NULL WHERE "created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "workspace_join_links" t SET "created_by" = NULL WHERE "created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."created_by");
UPDATE "attachments" t SET "uploaded_by" = NULL WHERE "uploaded_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."uploaded_by");
UPDATE "orders" t SET "user_id" = NULL, "email" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");
UPDATE "memberships" t SET "user_id" = NULL, "email" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = t."user_id");

-- Fix counters that deleted accounts left stale (one statement, only rows that differ).
UPDATE "workspaces" w SET "member_count" = c.n
  FROM (SELECT w2.id, (SELECT count(*) FROM "workspace_members" m WHERE m."workspace_id" = w2.id) AS n FROM "workspaces" w2) c
 WHERE c.id = w.id AND w."member_count" <> c.n;

-- 4. Foreign keys to users, added NOT VALID (instant) and validated one by one below.
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "board_stars" ADD CONSTRAINT "board_stars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "card_members" ADD CONSTRAINT "card_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "card_watchers" ADD CONSTRAINT "card_watchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "cards" ADD CONSTRAINT "cards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workspace_join_links" ADD CONSTRAINT "workspace_join_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- Validate each one separately (a lighter lock than adding it validated; the orphans are already gone).
ALTER TABLE "user_profiles" VALIDATE CONSTRAINT "user_profiles_user_id_fkey";
ALTER TABLE "workspace_members" VALIDATE CONSTRAINT "workspace_members_user_id_fkey";
ALTER TABLE "board_members" VALIDATE CONSTRAINT "board_members_user_id_fkey";
ALTER TABLE "board_stars" VALIDATE CONSTRAINT "board_stars_user_id_fkey";
ALTER TABLE "card_members" VALIDATE CONSTRAINT "card_members_user_id_fkey";
ALTER TABLE "card_watchers" VALIDATE CONSTRAINT "card_watchers_user_id_fkey";
ALTER TABLE "comment_mentions" VALIDATE CONSTRAINT "comment_mentions_user_id_fkey";
ALTER TABLE "conversation_members" VALIDATE CONSTRAINT "conversation_members_user_id_fkey";
ALTER TABLE "message_reactions" VALIDATE CONSTRAINT "message_reactions_user_id_fkey";
ALTER TABLE "message_mentions" VALIDATE CONSTRAINT "message_mentions_user_id_fkey";
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_user_id_fkey";
ALTER TABLE "saved_filters" VALIDATE CONSTRAINT "saved_filters_user_id_fkey";
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_actor_id_fkey";
ALTER TABLE "comments" VALIDATE CONSTRAINT "comments_author_id_fkey";
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_sender_id_fkey";
ALTER TABLE "activity" VALIDATE CONSTRAINT "activity_actor_id_fkey";
ALTER TABLE "cards" VALIDATE CONSTRAINT "cards_created_by_fkey";
ALTER TABLE "boards" VALIDATE CONSTRAINT "boards_created_by_fkey";
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_created_by_fkey";
ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_created_by_fkey";
ALTER TABLE "workspace_invites" VALIDATE CONSTRAINT "workspace_invites_created_by_fkey";
ALTER TABLE "workspace_join_links" VALIDATE CONSTRAINT "workspace_join_links_created_by_fkey";
ALTER TABLE "attachments" VALIDATE CONSTRAINT "attachments_uploaded_by_fkey";
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_user_id_fkey";
ALTER TABLE "memberships" VALIDATE CONSTRAINT "memberships_user_id_fkey";

-- 5. Indexes the cascade / set-null scans need (the others already lead with the column).
CREATE INDEX "message_reactions_user_id_idx" ON "message_reactions"("user_id");
CREATE INDEX "activity_actor_id_idx" ON "activity"("actor_id");
CREATE INDEX "cards_created_by_idx" ON "cards"("created_by");
CREATE INDEX "boards_created_by_idx" ON "boards"("created_by");
CREATE INDEX "conversations_created_by_idx" ON "conversations"("created_by");
CREATE INDEX "workspaces_created_by_idx" ON "workspaces"("created_by");
CREATE INDEX "workspace_invites_created_by_idx" ON "workspace_invites"("created_by");
CREATE INDEX "workspace_join_links_created_by_idx" ON "workspace_join_links"("created_by");
CREATE INDEX "notifications_actor_id_idx" ON "notifications"("actor_id");

-- 6. The guard and the cleanup. BEFORE DELETE runs before the foreign keys act, in the same transaction as the
-- platform's DELETE FROM users: an exception rolls the whole deletion back.
CREATE FUNCTION lanefold_before_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  solo integer[];
  blocked integer;
  paid integer;
  busy integer;
BEGIN
  -- Lock EVERY workspace they belong to (owned or not), in id order, before anything changes: two deletions in the
  -- same workspaces take the locks in the same order, so they queue instead of deadlocking on member_count.
  PERFORM 1 FROM "workspaces" w
   WHERE w.id IN (SELECT workspace_id FROM "workspace_members" WHERE user_id = OLD.id)
   ORDER BY w.id FOR UPDATE;

  -- Owner of a workspace with other members and no other owner: blocked (archived ones too).
  SELECT count(*) INTO blocked FROM "workspace_members" me
   WHERE me.user_id = OLD.id AND me.role = 'owner'
     AND EXISTS (SELECT 1 FROM "workspace_members" o WHERE o.workspace_id = me.workspace_id AND o.user_id <> OLD.id)
     AND NOT EXISTS (SELECT 1 FROM "workspace_members" o WHERE o.workspace_id = me.workspace_id AND o.role = 'owner' AND o.user_id <> OLD.id);
  IF blocked > 0 THEN
    RAISE EXCEPTION 'last_workspace_owner: make someone else an owner of % workspace(s) first', blocked USING ERRCODE = 'P0001';
  END IF;

  -- Workspaces where they are the only member (and so the owner).
  SELECT coalesce(array_agg(me.workspace_id), ARRAY[]::integer[]) INTO solo FROM "workspace_members" me
   WHERE me.user_id = OLD.id AND me.role = 'owner'
     AND NOT EXISTS (SELECT 1 FROM "workspace_members" o WHERE o.workspace_id = me.workspace_id AND o.user_id <> OLD.id);
  SELECT count(*) INTO paid FROM "workspaces" w WHERE w.id = ANY(solo) AND w.plan <> 'free';
  IF paid > 0 THEN
    RAISE EXCEPTION 'paid_workspace: move % paid workspace(s) to the free plan first', paid USING ERRCODE = 'P0001';
  END IF;
  -- They go with the account only when empty: no boards with cards (their own Inbox does not count: it is always
  -- deleted), no files, and no chat except an untouched default general channel.
  SELECT count(*) INTO busy FROM "workspaces" w WHERE w.id = ANY(solo) AND (
       EXISTS (SELECT 1 FROM "cards" c JOIN "boards" b ON b.id = c.board_id
                WHERE c.workspace_id = w.id AND b.inbox_of IS DISTINCT FROM OLD.id)
    OR EXISTS (SELECT 1 FROM "attachments" a
                WHERE a.workspace_id = w.id
                  AND NOT coalesce(a.card_id IN (SELECT c.id FROM "cards" c JOIN "boards" b ON b.id = c.board_id WHERE b.inbox_of = OLD.id), false))
    OR EXISTS (SELECT 1 FROM "conversations" v WHERE v.workspace_id = w.id AND NOT (v.kind = 'channel' AND v.name = 'general' AND v.board_id IS NULL))
    OR EXISTS (SELECT 1 FROM "messages" m WHERE m.workspace_id = w.id));
  IF busy > 0 THEN
    RAISE EXCEPTION 'workspace_needs_action: % workspace(s) still have boards, cards, files or messages; delete or move them first', busy USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(solo) > 0 THEN
    DELETE FROM "conversations" WHERE workspace_id = ANY(solo);
    DELETE FROM "activity" WHERE workspace_id = ANY(solo);
    DELETE FROM "card_links" WHERE workspace_id = ANY(solo);
    DELETE FROM "notifications" WHERE workspace_id = ANY(solo);
    DELETE FROM "attachments" WHERE workspace_id = ANY(solo);
    DELETE FROM "workspaces" WHERE id = ANY(solo);
  END IF;

  -- Their personal Inbox board(s), with cards, comments and files (the outbox trigger queues the files) and what
  -- hangs off them without a foreign key.
  DELETE FROM "conversations" WHERE board_id IN (SELECT id FROM "boards" WHERE inbox_of = OLD.id);
  DELETE FROM "activity" a WHERE a.board_id IN (SELECT id FROM "boards" WHERE inbox_of = OLD.id)
     OR a.card_id IN (SELECT c.id FROM "cards" c JOIN "boards" b ON b.id = c.board_id WHERE b.inbox_of = OLD.id);
  DELETE FROM "card_links" l WHERE l.card_id IN (SELECT c.id FROM "cards" c JOIN "boards" b ON b.id = c.board_id WHERE b.inbox_of = OLD.id)
     OR l.linked_card_id IN (SELECT c.id FROM "cards" c JOIN "boards" b ON b.id = c.board_id WHERE b.inbox_of = OLD.id);
  DELETE FROM "notifications" n WHERE n.board_id IN (SELECT id FROM "boards" WHERE inbox_of = OLD.id)
     OR n.card_id IN (SELECT c.id FROM "cards" c JOIN "boards" b ON b.id = c.board_id WHERE b.inbox_of = OLD.id);
  DELETE FROM "boards" WHERE inbox_of = OLD.id;

  -- Seats: one less in every workspace they were in (before the cascade removes the rows).
  UPDATE "workspaces" w SET "member_count" = GREATEST(w."member_count" - 1, 0)
    FROM "workspace_members" m WHERE m.user_id = OLD.id AND m.workspace_id = w.id;

  -- Paid history stays; the person does not.
  UPDATE "orders" SET "email" = NULL WHERE "user_id" = OLD.id;
  UPDATE "memberships" SET "email" = NULL WHERE "user_id" = OLD.id;
  RETURN OLD;
END $$;

CREATE TRIGGER lanefold_before_user_delete BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION lanefold_before_user_delete();

COMMIT;
