-- D127 — a label print job has no sale (Phase 5, step 5.7).
--
-- Two changes, both additive in effect:
--
--   1. `PrintJobType` gains PRODUCT_LABEL. Adding an enum value is additive and
--      needs no exception (D120); it cannot be used in the same transaction that
--      adds it (D120a), which is why nothing here inserts one.
--   2. `PrintJob.saleId` is widened from NOT NULL to nullable.
--
-- No existing row is touched. Every receipt, picking slip and return document
-- keeps the saleId it already has, and every existing writer still supplies
-- one. Widening a column can neither fail on existing data nor lose any.
--
-- The FK and its ON DELETE CASCADE are unchanged: a job that DOES belong to a
-- sale still dies with it. A label job simply has no parent to die with.

-- AlterEnum
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'PRODUCT_LABEL';

-- AlterTable
ALTER TABLE "PrintJob" ALTER COLUMN "saleId" DROP NOT NULL;
