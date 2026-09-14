-- D175 — store credit becomes a ledger a shop can actually read.
--
-- Until now `refundMethod = 'STORE_CREDIT'` was a LABEL on a return and nothing
-- else. No table, column or ledger recorded what the shop then owed, the
-- customer screen's "Available credit" is a different figure entirely
-- (`creditLimit - outstandingCredit`, how much they may buy ON ACCOUNT), and
-- nothing checked a balance when store credit was tendered on a sale.
--
-- A QuickBooks tenant's STORE_CREDIT return also becomes a Credit Memo and
-- QuickBooks tracks a balance of its own, which is how the gap survived: the
-- feature was designed assuming an accounting provider owned it. A LOCAL
-- tenant with NONE accounting has no such owner, and `allowStoreCredit` is
-- true by default, so every local shop has been able to give credit that goes
-- nowhere.
--
-- ## Purely additive
--
-- One enum and one table. NO existing table is altered, no column changes type,
-- no constraint is dropped. Hardware and restaurant workspaces are untouched by
-- construction: nothing they read or write appears in this file.
--
-- ## Why a ledger and not a balance column
--
-- A `Customer.storeCreditBalance` column is one UPDATE away from being wrong
-- forever, and nothing in the row says how it got there. Entries are
-- append-only and SIGNED — positive issues, negative redeems — so the balance
-- is SUM(amount) and cannot drift from its own history because it IS its own
-- history. A correction is an offsetting ADJUSTMENT, so the trail survives it.
--
-- ## The unique index on returnId is the idempotency guard
--
-- A replayed or retried return must not credit the customer twice, and the
-- database is the only place that guarantee holds under concurrency. NULLs are
-- distinct in Postgres, so redemptions and adjustments are unaffected.

-- CreateEnum
CREATE TYPE "StoreCreditReason" AS ENUM ('RETURN_REFUND', 'SALE_REDEMPTION', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "StoreCreditEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" "StoreCreditReason" NOT NULL,
    "returnId" TEXT,
    "saleId" TEXT,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreCreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreCreditEntry_tenantId_customerId_idx" ON "StoreCreditEntry"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "StoreCreditEntry_tenantId_createdAt_idx" ON "StoreCreditEntry"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreCreditEntry_saleId_idx" ON "StoreCreditEntry"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreCreditEntry_returnId_key" ON "StoreCreditEntry"("returnId");

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Credit the customers who were already refunded as store credit. This is not
-- tidiness: the shop genuinely owes that money, and starting the ledger at zero
-- would erase a real liability on the day the feature that records it shipped.
--
-- Only COMPLETED returns with a saved customer. A DRAFT return has taken
-- nothing back yet, and a return with no customer could not have been store
-- credit under the existing rule (`validateRefundMethod` refuses it), so the
-- predicate is belt and braces rather than a filter that changes the answer.
--
-- `createdByUserId` is the person who took the return, so the backfilled entry
-- names the same operator the return does. `note` marks the row as backfilled,
-- because an entry that appeared without anyone doing anything on the day
-- should say so when someone asks.
INSERT INTO "StoreCreditEntry" ("id", "tenantId", "customerId", "amount", "reason", "returnId", "note", "createdByUserId", "createdAt")
SELECT
    gen_random_uuid()::text,
    r."tenantId",
    r."customerId",
    r."refundTotal",
    'RETURN_REFUND',
    r."id",
    'Backfilled by D175 from an existing store-credit return',
    r."createdByUserId",
    COALESCE(r."completedAt", r."createdAt")
FROM "Return" r
WHERE r."refundMethod" = 'STORE_CREDIT'
  AND r."status" = 'COMPLETED'
  AND r."customerId" IS NOT NULL;
