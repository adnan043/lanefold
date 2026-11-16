-- Someone a board admin removed from a board cannot come back with the board's invite link, or with an email invite
-- made before the removal: a row per (board, user) holds the moment they were removed; acceptSeat refuses older
-- invites and every link. The row is deleted when a newer invite seats them again. The primary key serves the lookup.
-- Both foreign keys CASCADE: a deleted board or user takes its rows.
BEGIN;

CREATE TABLE "board_removals" (
    "board_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "removed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_removals_pkey" PRIMARY KEY ("board_id", "user_id")
);

ALTER TABLE "board_removals" ADD CONSTRAINT "board_removals_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_removals" ADD CONSTRAINT "board_removals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "board_removals_user_id_idx" ON "board_removals"("user_id");

COMMIT;
