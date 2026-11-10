-- Card dependencies: "blocker blocks blocked" on one board, plus two counters on cards for the card face.
BEGIN;

ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "blocked_by_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "blocking_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "card_dependencies" (
    "blocker_id" INTEGER NOT NULL,
    "blocked_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "board_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "card_dependencies_pkey" PRIMARY KEY ("blocker_id","blocked_id"),
    CONSTRAINT "card_dependencies_not_self" CHECK ("blocker_id" <> "blocked_id")
);

CREATE INDEX IF NOT EXISTS "card_dependencies_blocked_id_idx" ON "card_dependencies"("blocked_id");
CREATE INDEX IF NOT EXISTS "card_dependencies_workspace_id_board_id_idx" ON "card_dependencies"("workspace_id", "board_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'card_dependencies_blocker_id_fkey') THEN
    ALTER TABLE "card_dependencies" ADD CONSTRAINT "card_dependencies_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'card_dependencies_blocked_id_fkey') THEN
    ALTER TABLE "card_dependencies" ADD CONSTRAINT "card_dependencies_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
