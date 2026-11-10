BEGIN;

-- AlterTable: the admin's brand colour; null = the default green (expand-only: safe for the running code).
ALTER TABLE "app_settings" ADD COLUMN "brand_color" VARCHAR(7);

ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_brand_color_check"
  CHECK ("brand_color" IS NULL OR "brand_color" ~ '^#[0-9a-f]{6}$');

COMMIT;
