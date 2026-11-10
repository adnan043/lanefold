-- A due TIME and a chosen reminder on cards (the dates popup). Additive and safe to repeat; the old code ignores both.
--  due_at: the exact due moment; null = a due day only (every card before this, and cards dated by bulk, flows, drags).
--  due_remind_minutes: remind that many minutes before due_at; null = no timed reminder.
--  cards_due_time: a write that changes due_date without setting due_at drops the time and the reminder, so a time
--  never points at another day (those cards fall back to the day-before reminder). Clearing due_date clears both.
BEGIN;
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "due_at" TIMESTAMPTZ(3);
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "due_remind_minutes" INTEGER;

DO $$ BEGIN
  ALTER TABLE "cards" ADD CONSTRAINT "cards_due_remind_minutes_check"
    CHECK ("due_remind_minutes" IS NULL OR "due_remind_minutes" IN (0, 5, 10, 15, 60, 120, 1440, 2880));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "cards" ADD CONSTRAINT "cards_due_at_check"
    CHECK ("due_at" IS NULL OR "due_date" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION cards_due_time() RETURNS trigger AS $$
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
DROP TRIGGER IF EXISTS cards_due_time ON "cards";
CREATE TRIGGER cards_due_time BEFORE UPDATE OF "due_date", "due_at", "due_remind_minutes" ON "cards"
  FOR EACH ROW EXECUTE FUNCTION cards_due_time();
COMMIT;
