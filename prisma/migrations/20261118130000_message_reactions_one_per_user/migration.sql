-- One reaction per person per message: picking another emoji replaces the one you had.
-- Keep each person's most recent reaction on a message (ties: the larger emoji, so the pick is stable), drop the rest,
-- then let the database hold the rule. Safe for the previous code: its insert skips duplicates, so a second emoji
-- from the same person is simply not added.
BEGIN;

DELETE FROM "message_reactions" r
USING "message_reactions" newer
WHERE newer."message_id" = r."message_id"
  AND newer."user_id" = r."user_id"
  AND (newer."created_at", newer."emoji") > (r."created_at", r."emoji");

CREATE UNIQUE INDEX "message_reactions_message_id_user_id_key" ON "message_reactions"("message_id", "user_id");

COMMIT;
