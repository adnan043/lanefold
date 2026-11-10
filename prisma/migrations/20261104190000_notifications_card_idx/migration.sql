-- Moving a card to another board deletes or re-points that card's notifications: find them by card, not by scanning.
-- Additive and safe to repeat.
BEGIN;
CREATE INDEX IF NOT EXISTS "notifications_card_id_idx" ON "notifications"("card_id");
COMMIT;
