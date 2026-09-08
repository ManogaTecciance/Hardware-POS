-- CreateIndex
CREATE INDEX "Sale_tenantId_completedAt_idx" ON "Sale"("tenantId", "completedAt");
