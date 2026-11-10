-- Custom fields on boards (dropdown, text, number, date, checkbox) and their per-card values.
BEGIN;

CREATE TABLE "custom_fields" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "type" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custom_fields_type_check" CHECK ("type" IN ('text','number','date','checkbox','dropdown'))
);

CREATE TABLE "custom_field_options" (
    "id" SERIAL NOT NULL,
    "field_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "color_hex" VARCHAR(7) NOT NULL,
    CONSTRAINT "custom_field_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "card_field_values" (
    "card_id" INTEGER NOT NULL,
    "field_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "text_value" VARCHAR(200),
    "number_value" DOUBLE PRECISION,
    "date_value" DATE,
    "bool_value" BOOLEAN,
    "option_id" INTEGER,
    CONSTRAINT "card_field_values_pkey" PRIMARY KEY ("card_id","field_id")
);

CREATE INDEX "custom_fields_workspace_id_board_id_id_idx" ON "custom_fields"("workspace_id", "board_id", "id");
CREATE INDEX "custom_field_options_workspace_id_field_id_id_idx" ON "custom_field_options"("workspace_id", "field_id", "id");
CREATE INDEX "card_field_values_field_id_card_id_idx" ON "card_field_values"("field_id", "card_id");
CREATE INDEX "card_field_values_option_id_idx" ON "card_field_values"("option_id");

ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_field_options" ADD CONSTRAINT "custom_field_options_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "card_field_values" ADD CONSTRAINT "card_field_values_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "card_field_values" ADD CONSTRAINT "card_field_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "card_field_values" ADD CONSTRAINT "card_field_values_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "custom_field_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
