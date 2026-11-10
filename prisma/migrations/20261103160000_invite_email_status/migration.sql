-- Phase 11 invite emails: delivery state lives ON the invite row. The invitee's address is never stored here
-- (it travels only in the sealed background-job payload); `email_status` is one of
-- 'queued', 'sent', 'failed', 'not_configured', or NULL when no email was requested.
BEGIN;

ALTER TABLE "workspace_invites" ADD COLUMN "email_status" VARCHAR(16);
ALTER TABLE "workspace_invites" ADD COLUMN "email_queued_at" TIMESTAMPTZ(3);
ALTER TABLE "workspace_invites" ADD COLUMN "email_sent_at" TIMESTAMPTZ(3);
ALTER TABLE "workspace_invites" ADD COLUMN "email_attempts" INTEGER NOT NULL DEFAULT 0;

-- Hourly send limits count rows by workspace and by inviter over the last hour.
CREATE INDEX "workspace_invites_workspace_id_email_queued_at_idx" ON "workspace_invites"("workspace_id", "email_queued_at");
CREATE INDEX "workspace_invites_created_by_email_queued_at_idx" ON "workspace_invites"("created_by", "email_queued_at");

COMMIT;
