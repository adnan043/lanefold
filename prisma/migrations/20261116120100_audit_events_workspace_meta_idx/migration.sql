-- The workspace audit log's third branch (routes/workspace-audit.ts): chat / message / flow events matched by
-- meta->>'workspaceId' (compared as text), newest first. Without this it walks the whole audit_events table.
-- Partial on exactly the query's target_type list, so equality on the expression gives an id-ordered scan that stops at
-- the page size. Expression and predicate must stay identical to the query. CONCURRENTLY, alone, no BEGIN (database.md).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_events_meta_workspace_id_idx" ON "audit_events" (("meta" ->> 'workspaceId'), "id" DESC) WHERE "target_type" IN ('conversation', 'message', 'flow');
