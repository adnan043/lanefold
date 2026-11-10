-- Custom fields can be reordered (drag in the card's "Custom Fields" manager). Additive and safe to repeat:
-- the old code ignores the column (it orders by id, and its new fields get the default 0).
-- Backfill: each board's fields keep their current order (by id) as 1, 2, 3…
BEGIN;
ALTER TABLE "custom_fields" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;
UPDATE "custom_fields" f SET "position" = r.n
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "board_id" ORDER BY "id") AS n FROM "custom_fields") r
WHERE f."id" = r."id" AND f."position" = 0;
COMMIT;
