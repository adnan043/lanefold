-- Morning digest (opt-in, default off): per-person settings on user_profiles and the numbers behind a `digest`
-- notification. Additive and safe to repeat.
BEGIN;
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "digest_hour" SMALLINT;
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "digest_tz" VARCHAR(64);
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "digest_last_on" DATE;
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "digest_sent_at" TIMESTAMPTZ(3);
DO $$ BEGIN
  ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_digest_hour_check" CHECK ("digest_hour" IS NULL OR ("digest_hour" BETWEEN 5 AND 12));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "user_profiles_digest_hour_user_id_idx" ON "user_profiles"("digest_hour", "user_id");
CREATE TABLE IF NOT EXISTS "digests" (
    "notification_id" BIGINT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "due_count" INTEGER NOT NULL,
    "overdue_count" INTEGER NOT NULL,
    "mention_count" INTEGER NOT NULL,
    "card_ids" INTEGER[] NOT NULL,
    CONSTRAINT "digests_pkey" PRIMARY KEY ("notification_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "digests_user_id_day_key" ON "digests"("user_id", "day");
DO $$ BEGIN
  ALTER TABLE "digests" ADD CONSTRAINT "digests_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMIT;
