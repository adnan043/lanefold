-- Phase 7 Flows: per-board automation rules (trigger, conditions, actions in `config`). Hand-written, safe to repeat.
BEGIN;

CREATE TABLE IF NOT EXISTS "flows" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "trigger_kind" VARCHAR(16) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "last_run_on" DATE,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "flows_board_id_trigger_kind_enabled_idx" ON "flows"("board_id", "trigger_kind", "enabled");
CREATE INDEX IF NOT EXISTS "flows_workspace_id_id_idx" ON "flows"("workspace_id", "id");
CREATE INDEX IF NOT EXISTS "flows_trigger_kind_enabled_id_idx" ON "flows"("trigger_kind", "enabled", "id");

DO $$ BEGIN
  ALTER TABLE "flows" ADD CONSTRAINT "flows_trigger_kind_check" CHECK ("trigger_kind" IN ('card_created', 'card_moved', 'daily_due'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "flows" ADD CONSTRAINT "flows_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
