-- A checklist item can name one person and a due day. Additive and safe to repeat.
-- assignee_id follows users.id like cards.created_by: ON DELETE SET NULL (account deletion keeps the item, drops the name).
-- The index is for that foreign key (deleting a user finds their items) and for a later "my items" read.
BEGIN;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "assignee_id" INTEGER;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "due_date" DATE;
CREATE INDEX IF NOT EXISTS "checklist_items_assignee_id_idx" ON "checklist_items"("assignee_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_items_assignee_id_fkey') THEN
    ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_assignee_id_fkey"
      FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
COMMIT;
