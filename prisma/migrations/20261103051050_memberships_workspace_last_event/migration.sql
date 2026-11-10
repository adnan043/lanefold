BEGIN;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "last_event_at" TIMESTAMPTZ(3),
ADD COLUMN     "workspace_id" INTEGER;

-- CreateIndex
CREATE INDEX "memberships_workspace_id_status_idx" ON "memberships"("workspace_id", "status");

COMMIT;
