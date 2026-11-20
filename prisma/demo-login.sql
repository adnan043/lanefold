-- prisma/demo-login.sql: the store preview's READ-ONLY demo admin. Written by
-- `npm run platform -- demo-login`. The template's example: demo@example.com, password try-the-admin.
-- Run the command with your own address and password before you submit, and again to change them.
-- The platform runs this file ONLY on its previews (the review copy and the public "Try it"),
-- after prisma/seed.sql. A real install deletes it and never runs it. Data only: INSERT … ON
-- CONFLICT and UPDATE (anything else is refused at submit). Never put this account in
-- prisma/seed.sql or a migration. docs/agent/store-apps.md.
BEGIN;

-- The read permissions this site declares (rows the permission sync would add anyway).
INSERT INTO "permissions" ("codename", "title", "description", "group_name") VALUES
  ('site:user:read', 'See users', 'List users with their email, status and roles.', 'Users'),
  ('site:role:read', 'See roles', 'See roles and what each one allows.', 'Roles'),
  ('site:audit:read', 'See the activity log', 'Sign-ins, password changes, role changes.', 'Security')
ON CONFLICT ("codename") DO NOTHING;

-- Their default roles, as the permission sync grants them the first time.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM (VALUES ('admin', 'site:role:read'), ('admin', 'site:audit:read')) AS g(slug, codename)
JOIN "roles" r ON r."slug" = g.slug
JOIN "permissions" p ON p."codename" = g.codename
ON CONFLICT DO NOTHING;

-- The demo role: read and view permissions only, never a write.
INSERT INTO "roles" ("slug", "name", "description", "is_system", "updated_at") VALUES
  ('demo-read-only', 'Demo (read-only)', 'The store preview demo admin: opens every admin screen, changes nothing.', false, now())
ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "updated_at" = now();

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."codename" IN ('site:user:read', 'site:role:read', 'site:audit:read')
WHERE r."slug" = 'demo-read-only'
ON CONFLICT DO NOTHING;

-- The demo admin: confirmed, active, no two-step sign-in.
INSERT INTO "users" ("email", "name", "password_hash", "status", "email_verified_at", "updated_at") VALUES
  ('demo@example.com', 'Demo admin', 'scrypt$v1$16384$8$5$8zARmc_lQWs9pbmZnIHXNA$Z63wwrnD3-xsRFWplXo8PKyI5AZ4Jzj4n2r60qRoCQU', 'active', now(), now())
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "password_hash" = EXCLUDED."password_hash", "status" = 'active',
  "email_verified_at" = now(), "totp_secret_sealed" = NULL, "totp_pending_sealed" = NULL, "totp_enabled_at" = NULL,
  "session_version" = "users"."session_version" + 1, "updated_at" = now();

INSERT INTO "user_roles" ("user_id", "role_id")
SELECT u."id", r."id"
FROM "users" u
JOIN "roles" r ON r."slug" IN ('demo-read-only', 'member')
WHERE u."email" = 'demo@example.com'
ON CONFLICT DO NOTHING;

COMMIT;
