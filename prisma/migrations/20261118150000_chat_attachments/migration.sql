-- Chat attachments: files sent with a message (the same `attachments` table as cards, `message_id` set).
--
-- A file is uploaded first (no card, no message yet: "unsent"), then linked to the message it is sent with.
-- * The message owns it: deleting the message (or its conversation, which cascades to messages) deletes the row, and
--   the existing AFTER DELETE triggers give the bytes back to the workspace and queue the stored file for deletion.
-- * Lookups by message (a page of messages loads their files; the cascade finds them) use (message_id, id); the
--   (workspace_id, message_id, id) index was never used and goes.
-- * Unsent files are found per uploader (the composer's caps) and by age (the sweep drops ones never sent) through a
--   partial index: only the few rows in flight are in it.
BEGIN;

DELETE FROM "attachments" a
WHERE a."message_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = a."message_id");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "attachments_workspace_id_message_id_id_idx";
CREATE INDEX "attachments_message_id_id_idx" ON "attachments"("message_id", "id");

CREATE INDEX "attachments_unsent_idx" ON "attachments"("uploaded_by", "created_at")
  WHERE "card_id" IS NULL AND "message_id" IS NULL AND "file_id" IS NOT NULL;

COMMIT;
