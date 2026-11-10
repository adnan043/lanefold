BEGIN;

-- Trigram indexes for the ILIKE '%q%' search (src/server/routes/search.ts). Optional speed-up only: the query is
-- identical and correct without them. If the database does not allow pg_trgm, this migration still succeeds
-- (it just creates nothing) and search keeps scanning; run it again by hand once the extension is allowed.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%): search stays unindexed', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "cards_title_trgm_idx" ON "cards" USING GIN ("title" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "cards_description_md_trgm_idx" ON "cards" USING GIN ("description_md" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "boards_name_trgm_idx" ON "boards" USING GIN ("name" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "users_name_trgm_idx" ON "users" USING GIN ("name" gin_trgm_ops);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'trigram indexes skipped: %', SQLERRM;
END $$;

COMMIT;
