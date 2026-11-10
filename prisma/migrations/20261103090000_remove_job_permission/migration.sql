BEGIN;

-- The template's job board is gone: drop its permission (role grants cascade) and fix the Admin role's text.
DELETE FROM "permissions" WHERE "codename" = 'site:job:manage';

UPDATE "roles"
SET "description" = 'Manages users and reads the activity log.'
WHERE "slug" = 'admin' AND "is_system" = true AND "description" = 'Manages users, jobs and reads the activity log.';

COMMIT;
