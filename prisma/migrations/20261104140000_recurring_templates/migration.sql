-- Recurring cards (one rule per card, a scheduled job makes the copies) and saved templates (card or board lanes).
BEGIN;

CREATE TABLE IF NOT EXISTS "card_recurrences" (
    "card_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "board_id" INTEGER NOT NULL,
    "frequency" VARCHAR(8) NOT NULL,
    "anchor_on" DATE NOT NULL,
    "next_run_on" DATE NOT NULL,
    "last_run_on" DATE,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "card_recurrences_pkey" PRIMARY KEY ("card_id"),
    CONSTRAINT "card_recurrences_frequency_check" CHECK ("frequency" IN ('daily','weekly','monthly'))
);

CREATE TABLE IF NOT EXISTS "card_templates" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "card_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "card_templates_kind_check" CHECK ("kind" IN ('card','board'))
);

CREATE INDEX IF NOT EXISTS "card_recurrences_enabled_next_run_on_card_id_idx" ON "card_recurrences"("enabled", "next_run_on", "card_id");
CREATE INDEX IF NOT EXISTS "card_recurrences_workspace_id_idx" ON "card_recurrences"("workspace_id");
CREATE INDEX IF NOT EXISTS "card_templates_workspace_id_kind_id_idx" ON "card_templates"("workspace_id", "kind", "id");

DO $$ BEGIN
  ALTER TABLE "card_recurrences" ADD CONSTRAINT "card_recurrences_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "card_templates" ADD CONSTRAINT "card_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
