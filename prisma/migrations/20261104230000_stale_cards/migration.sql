-- Stale card warning: a per-board setting, the time a card entered its lane (kept by a trigger so EVERY way a card
-- changes lane is covered: moves, bulk, move-to-board, Flows, lane actions, restore), and the dedupe table of the
-- daily `stale-cards` job. Additive and safe to repeat.
--   * boards.stale_days: NULL = off (default). 3, 7, 14 or 30.
--   * cards.lane_entered_at: NOT NULL DEFAULT now(). A constant-like default, so adding it does not rewrite the table;
--     existing cards count from the day of this migration (a conservative start: nobody is nagged about old history).
BEGIN;
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "stale_days" INTEGER;
DO $$ BEGIN
  ALTER TABLE "boards" ADD CONSTRAINT "boards_stale_days_check" CHECK ("stale_days" IS NULL OR "stale_days" IN (3, 7, 14, 30));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "lane_entered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "cards_board_id_lane_entered_at_idx" ON "cards"("board_id", "lane_entered_at");

CREATE OR REPLACE FUNCTION cards_lane_entered() RETURNS trigger AS $$
BEGIN
  IF NEW.lane_id IS DISTINCT FROM OLD.lane_id
     OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN
    NEW.lane_entered_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cards_lane_entered ON "cards";
CREATE TRIGGER cards_lane_entered BEFORE UPDATE OF "lane_id", "archived_at" ON "cards"
  FOR EACH ROW EXECUTE FUNCTION cards_lane_entered();

CREATE TABLE IF NOT EXISTS "stale_reminders" (
    "card_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "entered_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stale_reminders_pkey" PRIMARY KEY ("card_id","user_id","entered_at")
);
CREATE INDEX IF NOT EXISTS "stale_reminders_user_id_idx" ON "stale_reminders"("user_id");
DO $$ BEGIN
  ALTER TABLE "stale_reminders" ADD CONSTRAINT "stale_reminders_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "stale_reminders" ADD CONSTRAINT "stale_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMIT;
