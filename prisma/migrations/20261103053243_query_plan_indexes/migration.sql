BEGIN;

-- Notifications list filtered to one workspace (routes/notifications.ts): without it the scan walks the user's whole history.
CREATE INDEX "notifications_user_id_workspace_id_id_idx" ON "notifications"("user_id", "workspace_id", "id" DESC);

-- Archived cards of a board, newest first (routes/board-extras.ts). Partial: Prisma's schema cannot express it, raw SQL only.
CREATE INDEX "cards_board_id_archived_id_idx" ON "cards" ("board_id", "id" DESC) WHERE "archived_at" IS NOT NULL;

COMMIT;
