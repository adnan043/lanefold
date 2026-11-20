-- One Inbox per person PER WORKSPACE (was: one per person across all workspaces).
-- Capturing into my Inbox in a second workspace created a second Inbox board and hit `boards_inbox_of_key`, so the
-- POST /workspaces/:id/inbox/cards transaction failed with a 500. The routes always look the Inbox up by
-- (workspace_id, inbox_of), so the uniqueness belongs on that pair. SQL-only (partial index); see the note in schema.prisma.
DROP INDEX IF EXISTS "boards_inbox_of_key";
CREATE UNIQUE INDEX "boards_inbox_of_workspace_id_key" ON "boards" ("inbox_of", "workspace_id") WHERE "inbox_of" IS NOT NULL;
