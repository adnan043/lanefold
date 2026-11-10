-- Recurring cards: "every N days / weeks / months" and an optional last day. Additive, safe to repeat.
BEGIN;

ALTER TABLE "card_recurrences" ADD COLUMN IF NOT EXISTS "interval_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "card_recurrences" ADD COLUMN IF NOT EXISTS "ends_on" DATE;

DO $$ BEGIN
  ALTER TABLE "card_recurrences" ADD CONSTRAINT "card_recurrences_interval_check" CHECK ("interval_count" BETWEEN 1 AND 99);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
