-- Pin every existing business to Sri Lanka's timezone.
--
-- Until now a business with no stored `timezone` fell through to the code
-- default at read time. That reads as Asia/Colombo today, but it is a default
-- rather than a decision: changing DEFAULT_TIME_ZONE later would silently move
-- every one of these businesses onto a different day boundary. Writing the
-- value makes it theirs.
--
-- Only rows without an explicit timezone are touched, so a zone an admin sets
-- afterwards survives this migration being re-applied to a newer database.

-- 1. Businesses that already keep a settings document.
UPDATE "TenantSettings"
SET "data" = jsonb_set("data", '{timezone}', '"Asia/Colombo"', true),
    "updatedAt" = NOW()
WHERE "branchId" IS NULL
  AND "data" ->> 'timezone' IS NULL;

-- 2. Businesses that have never saved settings, and so have no document at all.
--    A partial blob is enough: reads merge it over the code defaults, so every
--    other field keeps tracking its default.
INSERT INTO "TenantSettings" ("id", "tenantId", "branchId", "data", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", NULL, '{"timezone": "Asia/Colombo"}'::jsonb, NOW(), NOW()
FROM "Tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "TenantSettings" s
  WHERE s."tenantId" = t."id" AND s."branchId" IS NULL
);
