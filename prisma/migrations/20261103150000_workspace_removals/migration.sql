-- A removed (or departed) member cannot rejoin with an OLD join link or invite: a row per (workspace, user) holds the
-- moment they left; POST /invites/accept refuses a link/invite created before it. The row is deleted when they are
-- accepted again. The primary key serves the lookup.
-- Both foreign keys CASCADE: the account-deletion trigger deletes solo workspaces and the platform deletes users.
BEGIN;

CREATE TABLE "workspace_removals" (
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "removed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_removals_pkey" PRIMARY KEY ("workspace_id", "user_id")
);

ALTER TABLE "workspace_removals" ADD CONSTRAINT "workspace_removals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_removals" ADD CONSTRAINT "workspace_removals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "workspace_removals_user_id_idx" ON "workspace_removals"("user_id");

COMMIT;
