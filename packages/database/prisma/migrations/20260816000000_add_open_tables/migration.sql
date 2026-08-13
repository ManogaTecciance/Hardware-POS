-- D49. Open tables. Additive except two deliberate WIDENINGS (both named in
-- the decision record and the provider-contract test): RestaurantTable.areaId
-- and RestaurantTable.capacity DROP NOT NULL — null only ever written for
-- kind=OPEN rows; every existing row remains valid. Nothing is dropped,
-- renamed, or tightened.

-- CreateEnum
CREATE TYPE "RestaurantTableKind" AS ENUM ('PHYSICAL', 'OPEN');

-- AlterEnum
ALTER TYPE "RestaurantTableStatus" ADD VALUE 'RESERVED';

-- AlterTable
ALTER TABLE "RestaurantTable" ADD COLUMN     "kind" "RestaurantTableKind" NOT NULL DEFAULT 'PHYSICAL',
ALTER COLUMN "areaId" DROP NOT NULL,
ALTER COLUMN "capacity" DROP NOT NULL;

-- CreateTable
CREATE TABLE "OpenTableMember" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "openTableId" TEXT NOT NULL,
    "memberTableId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenTableMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenTableMember_tenantId_idx" ON "OpenTableMember"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OpenTableMember_openTableId_memberTableId_key" ON "OpenTableMember"("openTableId", "memberTableId");

-- CreateIndex
CREATE UNIQUE INDEX "OpenTableMember_memberTableId_key" ON "OpenTableMember"("memberTableId");

-- AddForeignKey
ALTER TABLE "OpenTableMember" ADD CONSTRAINT "OpenTableMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenTableMember" ADD CONSTRAINT "OpenTableMember_openTableId_fkey" FOREIGN KEY ("openTableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenTableMember" ADD CONSTRAINT "OpenTableMember_memberTableId_fkey" FOREIGN KEY ("memberTableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

