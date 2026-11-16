-- Same delete, for the board chat's notifications (conversation_id IN ...). CONCURRENTLY, alone, no BEGIN.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_conversation_id_idx" ON "notifications" ("conversation_id") WHERE "conversation_id" IS NOT NULL;
