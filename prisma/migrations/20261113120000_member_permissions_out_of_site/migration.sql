BEGIN;

-- Two permissions every default member holds move out of the `site:` namespace. The platform treats any
-- `site:` codename as an admin power (src/platform/auth/owner-seat.ts isAdminPower): with them under
-- `site:`, the `member` role counted as an admin role, so a change of site owner signed out every user.
--
-- Renamed IN PLACE, so every grant (role_permissions) and any change an owner made to them is kept.
-- If the new code already inserted the new codename (its first request ran before this migration),
-- the old row's grants are merged into it and the old row is removed. Safe to run twice.

-- 1. Where the new codename exists already: copy the old row's grants onto it.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", n."id"
FROM "role_permissions" rp
JOIN "permissions" o ON o."id" = rp."permission_id"
JOIN "permissions" n ON n."codename" = CASE o."codename"
    WHEN 'site:board:share' THEN 'board:share'
    WHEN 'site:board:flows' THEN 'board:flows'
  END
WHERE o."codename" IN ('site:board:share', 'site:board:flows')
ON CONFLICT DO NOTHING;

DELETE FROM "permissions" o
WHERE o."codename" IN ('site:board:share', 'site:board:flows')
  AND EXISTS (
    SELECT 1 FROM "permissions" n
    WHERE n."codename" = CASE o."codename"
        WHEN 'site:board:share' THEN 'board:share'
        WHEN 'site:board:flows' THEN 'board:flows'
      END
  );

-- 2. Otherwise: rename the row itself.
UPDATE "permissions" SET "codename" = 'board:share' WHERE "codename" = 'site:board:share';
UPDATE "permissions" SET "codename" = 'board:flows' WHERE "codename" = 'site:board:flows';

COMMIT;
