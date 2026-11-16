-- The daily Flows job stops between cards at its time budget and records where (jobs/flows.ts): the next hourly run
-- resumes the same day's run from the card after it instead of skipping the rest. Nullable, no default: instant.
BEGIN;
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "resume_after" INTEGER;
COMMIT;
