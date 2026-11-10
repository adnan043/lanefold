BEGIN;

-- Partial index for the board open query (routes/boards.ts: row_number() per lane over open cards of one board).
-- Prisma's schema cannot express a partial index, so it lives only here as raw SQL.
CREATE INDEX "cards_board_id_lane_id_position_id_open_idx"
  ON "cards" ("board_id", "lane_id", "position", "id")
  WHERE "archived_at" IS NULL;

COMMIT;
