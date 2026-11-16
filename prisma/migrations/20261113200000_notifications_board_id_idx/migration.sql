-- Turning a board private deletes its notifications (notification-cleanup.ts) while the board row is locked:
-- without this it scans the whole table. Partial: most rows have no board. CONCURRENTLY, alone, no BEGIN (database.md).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_board_id_idx" ON "notifications" ("board_id") WHERE "board_id" IS NOT NULL;
