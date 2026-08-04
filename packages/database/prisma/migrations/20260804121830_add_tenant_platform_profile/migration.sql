-- Slice 4 — platform business profile.
--
-- STRICTLY ADDITIVE. This migration only ever CREATEs:
--   4 × CREATE TYPE, 2 × CREATE TABLE, 3 × CREATE INDEX, 2 × ADD FOREIGN KEY.
--
-- It contains no DROP, no ALTER of an existing table, no column rename, no
-- UPDATE, and no INSERT. No existing tenant is backfilled: a tenant with no
-- TenantBusinessProfile row resolves to the legacy Tile Shop configuration, so
-- every existing tenant keeps its exact current behaviour with zero rows written.
--
-- Rollback: prisma/rollbacks/20260804121830_add_tenant_platform_profile.down.sql

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('TILE_SHOP', 'HARDWARE', 'RETAIL', 'RESTAURANT', 'CAFE', 'BAKERY', 'GENERAL');

-- CreateEnum
CREATE TYPE "InventoryMode" AS ENUM ('LOCAL', 'QUICKBOOKS', 'EXTERNAL', 'DISABLED');

-- CreateEnum
CREATE TYPE "AccountingProviderKind" AS ENUM ('NONE', 'QUICKBOOKS', 'FUTURE_EXTERNAL');

-- CreateEnum
CREATE TYPE "ModuleKey" AS ENUM ('RETAIL_POS', 'INVENTORY', 'CUSTOMERS', 'QUOTATIONS', 'RETURNS', 'EXCHANGES', 'SUPPLIERS', 'REPORTING', 'USERS', 'BRANCHES', 'SETTINGS', 'BRANDING', 'QUICKBOOKS', 'MENU_MANAGEMENT', 'DINING', 'TABLE_MANAGEMENT', 'TAKEAWAY', 'KITCHEN', 'KITCHEN_DISPLAY', 'ONLINE_ORDERS', 'DELIVERY_INTEGRATIONS', 'RESERVATIONS');

-- CreateTable
CREATE TABLE "TenantBusinessProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessType" "BusinessType" NOT NULL,
    "inventoryMode" "InventoryMode" NOT NULL,
    "accountingProvider" "AccountingProviderKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantBusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantModule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "moduleKey" "ModuleKey" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantModule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantBusinessProfile_tenantId_key" ON "TenantBusinessProfile"("tenantId");

-- CreateIndex
CREATE INDEX "TenantModule_tenantId_idx" ON "TenantModule"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantModule_tenantId_moduleKey_key" ON "TenantModule"("tenantId", "moduleKey");

-- AddForeignKey
ALTER TABLE "TenantBusinessProfile" ADD CONSTRAINT "TenantBusinessProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantModule" ADD CONSTRAINT "TenantModule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
