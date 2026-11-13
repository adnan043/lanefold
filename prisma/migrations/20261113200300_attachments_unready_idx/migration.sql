-- The daily sweep looks for abandoned uploads (ready = false): only a handful of rows, found without scanning attachments.
-- CONCURRENTLY, alone, no BEGIN.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "attachments_unready_idx" ON "attachments" ("id") WHERE "ready" = false;
