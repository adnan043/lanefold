-- Due date reminders: the dedupe table of the hourly `due-reminders` job and the index its page query walks.
-- Additive and safe to repeat.
BEGIN;
CREATE INDEX IF NOT EXISTS "cards_due_date_id_idx" ON "cards"("due_date", "id");
CREATE TABLE IF NOT EXISTS "due_reminders" (
    "card_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "due_on" DATE NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "due_reminders_pkey" PRIMARY KEY ("card_id","user_id","due_on")
);
CREATE INDEX IF NOT EXISTS "due_reminders_due_on_idx" ON "due_reminders"("due_on");
CREATE INDEX IF NOT EXISTS "due_reminders_user_id_idx" ON "due_reminders"("user_id");
DO $$ BEGIN
  ALTER TABLE "due_reminders" ADD CONSTRAINT "due_reminders_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "due_reminders" ADD CONSTRAINT "due_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMIT;
