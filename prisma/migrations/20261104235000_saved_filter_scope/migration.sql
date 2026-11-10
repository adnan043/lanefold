-- A saved filter can be shared with everyone who sees its board. Additive and safe to repeat.
-- scope: 'private' (only its author, as before; every existing row) or 'board' (everyone with a seat on the board).
-- The index serves the list read: my filters on a board plus the board's shared ones.
BEGIN;
ALTER TABLE "saved_filters" ADD COLUMN IF NOT EXISTS "scope" VARCHAR(8) NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS "saved_filters_board_id_scope_id_idx" ON "saved_filters"("board_id", "scope", "id");
COMMIT;
