-- Phase 1.5.5. Purely additive: two columns with defaults, no data migration.
--
-- `isActive` supports archival. The Product Owner ruled out hard deletion for
-- tenant roles: an archived role keeps every historical assignment and audit
-- reference, cannot be assigned to anyone new, and fails closed for any user who
-- still holds one. Built-in roles can be neither deleted nor archived.
--
-- `version` is an optimistic-concurrency token, matching TenantBusinessProfile.
-- Two administrators editing one role must not silently overwrite each other.

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
