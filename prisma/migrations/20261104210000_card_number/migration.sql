-- A short number per board for every card (#42): stable, never reused, the card's id stays the real key.
-- cards.number stays nullable: a card written by code older than this migration (during a publish) has none and shows none.
-- Numbers are handed out by `UPDATE boards SET next_card_number = next_card_number + N ... RETURNING` (a row lock, race-safe);
-- the unique index is the safety net. Additive and safe to repeat.
BEGIN;
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "next_card_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "number" INTEGER;

-- Backfill: existing cards of a board are numbered 1, 2, 3... in id (creation) order, in one statement.
UPDATE "cards" c SET "number" = t.rn
FROM (SELECT id, row_number() OVER (PARTITION BY board_id ORDER BY id) AS rn FROM "cards") t
WHERE c.id = t.id AND c."number" IS NULL;

UPDATE "boards" b SET "next_card_number" = m.mx + 1
FROM (SELECT board_id, MAX("number") AS mx FROM "cards" GROUP BY board_id) m
WHERE b.id = m.board_id AND b."next_card_number" <= m.mx;

CREATE UNIQUE INDEX IF NOT EXISTS "cards_board_id_number_key" ON "cards"("board_id", "number");
COMMIT;
