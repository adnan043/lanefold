-- The per-file ceiling is now 2047 MB (src/lib/file-limits.ts): attachments.size is an integer, so a bigger file
-- could not be saved. A plan an admin set higher (up to 5 GB was allowed) comes down to the ceiling.
BEGIN;
UPDATE "plan_limits" SET "max_file_bytes" = 2146435072 WHERE "max_file_bytes" > 2146435072;
COMMIT;
