-- D55. Platform admins and the HOTEL workspace template. Purely additive: one
-- enum value and one defaulted boolean, so no existing user gains anything and
-- every existing tenant keeps its business type.

-- AlterEnum
ALTER TYPE "BusinessType" ADD VALUE 'HOTEL';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

