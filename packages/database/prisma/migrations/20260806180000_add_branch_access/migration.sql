-- Phase 1.5.6. Additive: a per-user branch-access join table.
--
-- Preserves `User.branchId` as the user's default active branch — the login /
-- register-resolution flow depends on it — while allowing an OWNER/ADMIN or a
-- multi-branch cashier to switch between several branches the tenant has
-- granted them access to. The `BranchScopeGuard` re-validates the token's
-- `activeBranchId` against this table on every branch-scoped request
-- (decision D38, AD-02, AD-04).
--
-- No data migration. Existing users are unaffected: their `User.branchId`
-- remains the sole source of truth until a `BranchAccess` row is created.

-- CreateTable
CREATE TABLE "BranchAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" TEXT,

    CONSTRAINT "BranchAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BranchAccess_branchId_idx" ON "BranchAccess"("branchId");

-- CreateIndex
CREATE INDEX "BranchAccess_userId_idx" ON "BranchAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchAccess_userId_branchId_key" ON "BranchAccess"("userId", "branchId");

-- AddForeignKey
ALTER TABLE "BranchAccess" ADD CONSTRAINT "BranchAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchAccess" ADD CONSTRAINT "BranchAccess_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
