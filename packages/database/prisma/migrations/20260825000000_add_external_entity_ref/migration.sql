-- D63 — ExternalEntityRef: the one home for external identity (convergence
-- plan Phase 6, §4.9.4). Purely additive; the legacy vendor columns keep
-- being written (dual-write) until a production reconciliation cycle
-- proves the satellite complete. QuickBooksMapping is COPIED in by the
-- backfill script, never dropped here.

-- CreateTable
CREATE TABLE "ExternalEntityRef" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "externalId" TEXT,
    "externalType" TEXT,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'NOT_SYNCED',
    "syncError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalEntityRef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalEntityRef_tenantId_provider_syncStatus_idx" ON "ExternalEntityRef"("tenantId", "provider", "syncStatus");

-- CreateIndex
CREATE INDEX "ExternalEntityRef_tenantId_provider_entityType_externalId_idx" ON "ExternalEntityRef"("tenantId", "provider", "entityType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEntityRef_tenantId_provider_entityType_localId_key" ON "ExternalEntityRef"("tenantId", "provider", "entityType", "localId");

ALTER TABLE "ExternalEntityRef" ADD CONSTRAINT "ExternalEntityRef_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

