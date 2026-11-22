-- Plan limits like Trello (Free / Standard / Premium):
--   Free: 10 members, 10 open boards, 10 MB per file, 250 flow runs a month.
--   Pro:  unlimited members and boards, 250 MB per file, 1,000 flow runs a month.
--   Team: unlimited members and boards, 250 MB per file, unlimited flow runs, audit log.
-- No storage quota on any plan. "Unlimited" members is the app's safety cap (500, SAFETY_CAPS.maxMembers);
-- a NULL max_boards / flow_runs_per_month is unlimited (behind the safety caps in src/server/entitlements.ts).
-- Expand only: storage_quota_bytes and max_flows stay (the previous release reads them) and are dropped later.
-- The personal Inbox is gone: each one becomes an ordinary private board its owner keeps.
BEGIN;

ALTER TABLE "plan_limits"
  ADD COLUMN "max_boards" INTEGER,
  ADD COLUMN "flow_runs_per_month" INTEGER,
  ADD COLUMN "rank" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "plan_limits"
  ADD CONSTRAINT "plan_limits_max_boards_check" CHECK ("max_boards" IS NULL OR "max_boards" >= 1),
  ADD CONSTRAINT "plan_limits_flow_runs_check" CHECK ("flow_runs_per_month" IS NULL OR "flow_runs_per_month" >= 0);

UPDATE "plan_limits" SET "max_members" = 10,  "max_boards" = 10,   "max_file_bytes" = 10485760,  "flow_runs_per_month" = 250,  "rank" = 0, "updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'free';
UPDATE "plan_limits" SET "max_members" = 500, "max_boards" = NULL, "max_file_bytes" = 262144000, "flow_runs_per_month" = 1000, "rank" = 1, "audit_log" = false, "updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'pro';
UPDATE "plan_limits" SET "max_members" = 500, "max_boards" = NULL, "max_file_bytes" = 262144000, "flow_runs_per_month" = NULL, "rank" = 2, "audit_log" = true, "updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'team';
-- The new per-file ceiling (src/lib/file-limits.ts) is 250 MB.
UPDATE "plan_limits" SET "max_file_bytes" = 262144000 WHERE "max_file_bytes" > 262144000;
-- A workspace's member_limit copy follows its plan.
UPDATE "workspaces" w SET "member_limit" = p."max_members" FROM "plan_limits" p WHERE p."plan" = w."plan" AND w."member_limit" <> p."max_members";

-- Flow runs per workspace per calendar month (UTC). One row a month; the run engine reserves runs in ONE statement.
CREATE TABLE "flow_run_counts" (
  "workspace_id" INTEGER NOT NULL,
  "month" DATE NOT NULL,
  "runs" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "flow_run_counts_pkey" PRIMARY KEY ("workspace_id", "month"),
  CONSTRAINT "flow_run_counts_runs_check" CHECK ("runs" >= 0),
  CONSTRAINT "flow_run_counts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Inboxes: the owner (still a member) gets a seat on it as a private board; an Inbox whose owner left is archived.
INSERT INTO "board_members" ("board_id", "user_id", "workspace_id", "role")
SELECT b."id", b."inbox_of", b."workspace_id", CASE WHEN m."role" = 'viewer' THEN 'viewer' ELSE 'admin' END
FROM "boards" b JOIN "workspace_members" m ON m."workspace_id" = b."workspace_id" AND m."user_id" = b."inbox_of"
WHERE b."inbox_of" IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE "boards" b SET "archived_at" = CURRENT_TIMESTAMP
WHERE b."inbox_of" IS NOT NULL AND b."archived_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "workspace_members" m WHERE m."workspace_id" = b."workspace_id" AND m."user_id" = b."inbox_of");
UPDATE "boards" SET "inbox_of" = NULL, "visibility" = 'private' WHERE "inbox_of" IS NOT NULL;

COMMIT;
