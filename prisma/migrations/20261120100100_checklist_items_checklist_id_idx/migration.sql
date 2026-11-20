-- Deleting a checklist cascades to its items by checklist_id, which led no index: the delete read the whole index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "checklist_items_checklist_id_idx" ON "checklist_items" ("checklist_id");
