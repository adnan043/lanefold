-- A card moved to another board leaves no row on its source board (the card row's board_id changes), so the source
-- board's delta (`GET /boards/:id/changes`) could not tell its viewers the card is gone. One row per move, stamped with
-- the source board's rev of that move; the delta reads them by (board_id, rev). The board FK CASCADEs (a deleted board
-- takes its rows); card_id has no FK: the card lives on, on its new board.
BEGIN;

CREATE TABLE "card_board_exits" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "board_id" INTEGER NOT NULL,
    "card_id" INTEGER NOT NULL,
    "rev" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_board_exits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "card_board_exits_board_id_rev_idx" ON "card_board_exits"("board_id", "rev");

ALTER TABLE "card_board_exits" ADD CONSTRAINT "card_board_exits_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
