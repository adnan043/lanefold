BEGIN;

-- Owner-archived workspaces (routes/workspace-settings.ts): hidden and closed, never deleted; the owner can restore.
ALTER TABLE "workspaces" ADD COLUMN "archived_at" TIMESTAMPTZ(3),
ADD COLUMN "archived_by" INTEGER;

-- Only archived rows are ever listed by owner ("my archived workspaces"), so the index is partial.
CREATE INDEX "workspaces_archived_idx" ON "workspaces" ("id") WHERE "archived_at" IS NOT NULL;

COMMIT;
