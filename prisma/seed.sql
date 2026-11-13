-- prisma/seed.sql: made-up sample data. Never for a live database.
-- Where it is loaded: a review copy and a public preview of this site, the staging database
-- when the owner presses "Load sample data" (never their live one), and your own machine with
-- `npm run db:seed`. No users: people sign up. Safe to run twice, all or nothing.
--
-- What it adds: one sample workspace ("Example Co") with one PUBLIC read-only board, so the sample is
-- visible without an account at:
--   /b/lanefold-sample-board-read-only-preview-000/
-- The token is public on purpose (this file is in the repository); only its SHA-256 is stored, as for
-- every share link. Signed-in people never see this workspace: it has no members.
BEGIN;

-- Stop when real data is there: any workspace but the sample one means the app is in use.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "workspaces" WHERE "slug" <> 'example-co-sample') THEN
    RAISE EXCEPTION 'prisma/seed.sql is sample data and this database already has workspaces. Nothing was changed.';
  END IF;
END $$;

-- One chain: everything hangs off the workspace insert, so a second run (slug taken) inserts nothing.
WITH ws AS (
  INSERT INTO "workspaces" ("name", "slug", "updated_at")
  VALUES ('Example Co', 'example-co-sample', now())
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id"
), board AS (
  INSERT INTO "boards" ("workspace_id", "name", "visibility", "bg_color_1", "bg_color_2", "share_token_hash", "next_card_number", "rev", "updated_at")
  SELECT ws."id", 'Website launch', 'public', '#DCFCE7', '#E0E7FF',
         'bc7ae6f861212bfd9c9167d5b7b4468215c1be8ec05ca05d2634a187110a329c', 8, 1, now()
  FROM ws
  RETURNING "id", "workspace_id"
), lane AS (
  INSERT INTO "lanes" ("board_id", "workspace_id", "name", "position", "card_count", "updated_at")
  SELECT board."id", board."workspace_id", v.name, v.pos, v.n, now()
  FROM board, (VALUES ('To do', 'a0', 3), ('In progress', 'a1', 2), ('Review', 'a2', 1), ('Done', 'a3', 1)) AS v(name, pos, n)
  RETURNING "id", "name", "board_id", "workspace_id"
), label AS (
  INSERT INTO "labels" ("board_id", "workspace_id", "name", "color_hex", "updated_at")
  SELECT board."id", board."workspace_id", v.name, v.color, now()
  FROM board, (VALUES ('Design', '#7C3AED'), ('Content', '#2563EB'), ('Bug', '#DC2626')) AS v(name, color)
  RETURNING "id", "name"
), card AS (
  INSERT INTO "cards" ("board_id", "lane_id", "workspace_id", "title", "description_md", "position", "priority", "number", "completed_at", "updated_at")
  SELECT lane."board_id", lane."id", lane."workspace_id", c.title, c.body, c.pos, c.prio, c.num,
         CASE WHEN lane."name" = 'Done' THEN now() END, now()
  FROM lane
  JOIN (VALUES
    ('To do', 'Write the pricing page copy', E'Three plans, one flat price per workspace.\n\nKeep it short.', 'a0', 'medium', 1),
    ('To do', 'Pick the hero photo', '', 'a1', 'low', 2),
    ('To do', 'Set up the contact form', 'Send replies to hello@example.com.', 'a2', 'none', 3),
    ('In progress', 'Homepage layout', E'Mobile first.\n\nCheck it at 360px wide.', 'a0', 'high', 4),
    ('In progress', 'Fix the menu on small phones', 'The menu button overlaps the logo below 380px.', 'a1', 'high', 5),
    ('Review', 'About page draft', '', 'a0', 'medium', 6),
    ('Done', 'Choose the brand colours', '', 'a0', 'none', 7)
  ) AS c(lane, title, body, pos, prio, num) ON c.lane = lane."name"
  RETURNING "id", "title"
)
INSERT INTO "card_labels" ("card_id", "label_id")
SELECT card."id", label."id"
FROM card
JOIN (VALUES
  ('Write the pricing page copy', 'Content'),
  ('Pick the hero photo', 'Design'),
  ('Homepage layout', 'Design'),
  ('Fix the menu on small phones', 'Bug'),
  ('About page draft', 'Content'),
  ('Choose the brand colours', 'Design')
) AS v(title, label) ON v.title = card."title"
JOIN label ON label."name" = v.label
ON CONFLICT DO NOTHING;

COMMIT;
