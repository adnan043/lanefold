-- The bell badge (polled every 30 s) and the unread list read `user_id = $1 AND read_at IS NULL ORDER BY id DESC LIMIT n`.
-- `(user_id, read_at, id)` cannot give that order (IS NULL is not an equality for ordering): every unread row of the
-- person was read and sorted before the LIMIT. This partial index is read newest first and stops at the limit
-- (measured: 3.3k unread rows, 24 ms -> 0.24 ms). CONCURRENTLY, alone, no BEGIN.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_user_unread_idx" ON "notifications" ("user_id", "id" DESC) WHERE "read_at" IS NULL;
