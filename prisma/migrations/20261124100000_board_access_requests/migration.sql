-- Requests to join a board someone cannot open (the "This board is private: send a request" screen).
-- One row per person per board; status pending | approved | declined. Expand only: nothing existing changes.
BEGIN;

CREATE TABLE "board_access_requests" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" INTEGER,

    CONSTRAINT "board_access_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "board_access_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'declined'))
);

CREATE INDEX "board_access_requests_board_id_status_id_idx" ON "board_access_requests"("board_id", "status", "id" DESC);
CREATE INDEX "board_access_requests_user_id_requested_at_idx" ON "board_access_requests"("user_id", "requested_at");
CREATE UNIQUE INDEX "board_access_requests_board_id_user_id_key" ON "board_access_requests"("board_id", "user_id");

ALTER TABLE "board_access_requests" ADD CONSTRAINT "board_access_requests_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SQL only (like board_removals): a deleted account takes its requests with it; a deleted approver leaves the decision.
ALTER TABLE "board_access_requests" ADD CONSTRAINT "board_access_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_access_requests" ADD CONSTRAINT "board_access_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
