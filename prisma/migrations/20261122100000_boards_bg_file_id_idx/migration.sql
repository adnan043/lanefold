-- Chat's unsent files and their daily sweep skip a file a board still shows as its background
-- (NOT EXISTS ... boards.bg_file_id = attachments.file_id): that lookup needs an index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "boards_bg_file_id_idx" ON "boards" ("bg_file_id");
