-- Workspace card search filters by workspace and keyset-pages by id DESC; no index started with (workspace_id, id),
-- so a rare or 2-letter search walked every tenant's cards. Concurrent: alone in its own migration (database.md).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cards_workspace_id_id_idx" ON "cards" ("workspace_id", "id");
