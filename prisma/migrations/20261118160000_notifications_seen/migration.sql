-- Notifications: "seen" apart from "read". Opening the bell's list marks everything up to then as seen, which clears
-- the red count; each notification stays unread (its own background in the list) until it is opened or marked read.
-- The newest notification id seen; the count only counts unread notifications above it.
ALTER TABLE "user_profiles" ADD COLUMN "notifications_seen_id" BIGINT NOT NULL DEFAULT 0;
