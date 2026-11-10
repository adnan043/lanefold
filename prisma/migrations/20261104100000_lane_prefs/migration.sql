-- Per-person lane choices: pin a lane, watch a lane. Rows exist only while a flag is on.
BEGIN;

CREATE TABLE "lane_prefs" (
    "user_id" INTEGER NOT NULL,
    "lane_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "board_id" INTEGER NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "watching" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lane_prefs_pkey" PRIMARY KEY ("user_id","lane_id")
);

CREATE INDEX "lane_prefs_lane_id_idx" ON "lane_prefs"("lane_id");
CREATE INDEX "lane_prefs_user_id_board_id_idx" ON "lane_prefs"("user_id", "board_id");

ALTER TABLE "lane_prefs" ADD CONSTRAINT "lane_prefs_lane_id_fkey" FOREIGN KEY ("lane_id") REFERENCES "lanes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
