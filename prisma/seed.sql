-- prisma/seed.sql: made-up sample data. Never for a live database.
-- Where it is loaded: a review copy and a public preview of this site, the staging database
-- when the owner presses "Load sample data" (never their live one), and your own machine with
-- `npx prisma db seed`. No users: people sign up. Safe to run twice, all or nothing.
BEGIN;

-- Stop when real data is there: this job board is already in use.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "jobs"
    WHERE "slug" NOT IN ('customer-success-manager', 'frontend-developer', 'content-writer')
  ) THEN
    RAISE EXCEPTION 'prisma/seed.sql is sample data and this job board is already in use. Nothing was changed.';
  END IF;
END $$;

-- Unique slugs and ON CONFLICT DO NOTHING: safe to run twice.
INSERT INTO "jobs" ("slug", "title", "company", "location", "type", "remote", "description", "apply_url", "status", "created_by", "updated_at") VALUES
  ('customer-success-manager', 'Customer Success Manager', 'Example Co', 'London', 'full-time', true,
   E'Help our customers get the most out of what we make.\n\nYou will run onboarding sessions, answer questions and keep every conversation kind.',
   'mailto:jobs@example.com', 'open', 0, now()),
  ('frontend-developer', 'Frontend Developer', 'Sample Labs', 'Berlin', 'contract', true,
   E'Build fast, accessible pages with Astro and React.\n\nThree-month contract, possible extension.',
   'https://example.com/careers/frontend', 'open', 0, now()),
  ('content-writer', 'Content Writer', 'Demo Media', 'New York', 'part-time', false,
   E'Write guides and stories for our blog.\n\nTwo days a week, flexible hours.',
   'https://example.com/careers/writer', 'open', 0, now())
ON CONFLICT ("slug") DO NOTHING;

COMMIT;
