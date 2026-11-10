-- Phase 12 notification emails: a per-user preference on the profile row. Default OFF.
-- `email_notify_mode`: 'off' | 'digest' | 'immediate'. `email_notify_cursor` is the last notification id already
-- mailed (or skipped when the person switched it on); `email_notified_at` is the last send, for the hourly limit.
-- No address is stored here: it is read from "users" at send time only. Guarded so a re-run is harmless.
BEGIN;

ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "email_notify_mode" VARCHAR(10) NOT NULL DEFAULT 'off';
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "email_notify_cursor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "email_notified_at" TIMESTAMPTZ(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_email_notify_mode_check') THEN
    ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_email_notify_mode_check" CHECK ("email_notify_mode" IN ('off', 'digest', 'immediate'));
  END IF;
END $$;

-- The sweep only looks at the few people who turned it on.
CREATE INDEX IF NOT EXISTS "user_profiles_email_notify_mode_user_id_idx" ON "user_profiles"("email_notify_mode", "user_id");

COMMIT;
