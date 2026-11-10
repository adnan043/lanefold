-- A due TIME and a chosen reminder on checklist items (the item's due date popover), like cards_due_time.
-- Additive and safe to repeat; the old code ignores the new columns and table.
--  due_at: the exact due moment; null = a due day only (every item before this, and items dated by older code).
--  due_remind_minutes: remind that many minutes before due_at; null = no reminder.
--  checklist_items_due_time: a write that changes due_date without setting due_at drops the time and the reminder,
--  so a time never points at another day. Clearing due_date clears both.
--  item_due_reminders: one row per reminder sent (item, person, due moment), so a reminder goes out once; a new due
--  time is a new key. Rows go with the item (cascade) and with the person (cascade).
BEGIN;
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "due_at" TIMESTAMPTZ(3);
ALTER TABLE "checklist_items" ADD COLUMN IF NOT EXISTS "due_remind_minutes" INTEGER;

DO $$ BEGIN
  ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_due_remind_minutes_check"
    CHECK ("due_remind_minutes" IS NULL OR "due_remind_minutes" IN (0, 5, 10, 15, 60, 120, 1440, 2880));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_due_at_check"
    CHECK ("due_at" IS NULL OR "due_date" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION checklist_items_due_time() RETURNS trigger AS $$
BEGIN
  IF NEW.due_date IS NULL
     OR (NEW.due_date IS DISTINCT FROM OLD.due_date AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at) THEN
    NEW.due_at := NULL;
  END IF;
  IF NEW.due_at IS NULL THEN
    NEW.due_remind_minutes := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS checklist_items_due_time ON "checklist_items";
CREATE TRIGGER checklist_items_due_time BEFORE UPDATE OF "due_date", "due_at", "due_remind_minutes" ON "checklist_items"
  FOR EACH ROW EXECUTE FUNCTION checklist_items_due_time();

-- The reminder sweep reads timed items only.
CREATE INDEX IF NOT EXISTS "checklist_items_due_at_idx" ON "checklist_items"("due_at");

CREATE TABLE IF NOT EXISTS "item_due_reminders" (
    "item_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "item_due_reminders_pkey" PRIMARY KEY ("item_id", "user_id", "due_at")
);
CREATE INDEX IF NOT EXISTS "item_due_reminders_due_at_idx" ON "item_due_reminders"("due_at");
CREATE INDEX IF NOT EXISTS "item_due_reminders_user_id_idx" ON "item_due_reminders"("user_id");
DO $$ BEGIN
  ALTER TABLE "item_due_reminders" ADD CONSTRAINT "item_due_reminders_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "checklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "item_due_reminders" ADD CONSTRAINT "item_due_reminders_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMIT;
