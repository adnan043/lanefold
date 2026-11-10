-- Time tracking on cards: logged entries, plus ONE running timer per person. Additive and safe to repeat.
--  time_entries.user_id follows users.id like cards.created_by: ON DELETE SET NULL (account deletion keeps the minutes, drops the name).
--  time_timers.user_id is the primary key (one timer per person) and goes with the person (ON DELETE CASCADE).
--  Both follow their card (ON DELETE CASCADE). Indexes: the card's latest entries, the board report by day, one person's days.
BEGIN;

CREATE TABLE IF NOT EXISTS "time_entries" (
  "id" SERIAL NOT NULL,
  "card_id" INTEGER NOT NULL,
  "board_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "minutes" INTEGER NOT NULL,
  "spent_on" DATE NOT NULL,
  "note" VARCHAR(200) NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "time_entries_minutes_check" CHECK ("minutes" BETWEEN 1 AND 1440)
);
CREATE INDEX IF NOT EXISTS "time_entries_card_id_spent_on_id_idx" ON "time_entries"("card_id", "spent_on" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "time_entries_board_id_spent_on_idx" ON "time_entries"("board_id", "spent_on");
CREATE INDEX IF NOT EXISTS "time_entries_workspace_id_user_id_spent_on_idx" ON "time_entries"("workspace_id", "user_id", "spent_on");
CREATE INDEX IF NOT EXISTS "time_entries_user_id_idx" ON "time_entries"("user_id");

CREATE TABLE IF NOT EXISTS "time_timers" (
  "user_id" INTEGER NOT NULL,
  "card_id" INTEGER NOT NULL,
  "board_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "time_timers_pkey" PRIMARY KEY ("user_id")
);
CREATE INDEX IF NOT EXISTS "time_timers_card_id_idx" ON "time_timers"("card_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_card_id_fkey') THEN
    ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_card_id_fkey"
      FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_user_id_fkey') THEN
    ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_timers_card_id_fkey') THEN
    ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_card_id_fkey"
      FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_timers_user_id_fkey') THEN
    ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
