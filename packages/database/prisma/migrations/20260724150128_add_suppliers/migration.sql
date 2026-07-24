-- CreateEnum
CREATE TYPE "SupplierQbStatus" AS ENUM ('CONNECTED', 'WAITING', 'ATTENTION', 'NOT_CONNECTED');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "fax" TEXT,
    "website" TEXT,
    "street" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "openingBalance" DECIMAL(18,2),
    "openingBalanceDate" TIMESTAMP(3),
    "taxId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "quickbooksVendorId" TEXT,
    "quickbooksVendorName" TEXT,
    "qbStatus" "SupplierQbStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "qbLastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_tenantId_idx" ON "Supplier"("tenantId");

-- CreateIndex
CREATE INDEX "Supplier_tenantId_isActive_idx" ON "Supplier"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_name_key" ON "Supplier"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_quickbooksVendorId_key" ON "Supplier"("tenantId", "quickbooksVendorId");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

