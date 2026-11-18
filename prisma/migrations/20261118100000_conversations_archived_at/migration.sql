-- Channels can be archived (workspace owners and admins): hidden from the conversation list and read-only.
-- Nullable, no default: adding it is instant and safe for the running code, which never reads it.
BEGIN;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(3);
COMMIT;
