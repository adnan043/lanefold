-- The daily sweep deletes read notifications older than the retention window (jobs/sweeps.ts), oldest first:
-- each batch reads only rows it deletes instead of walking the whole table by id. CONCURRENTLY, alone, no BEGIN.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_read_at_idx" ON "notifications" ("read_at") WHERE "read_at" IS NOT NULL;
