-- Reshape Customer to mirror the QuickBooks Online Customer template fields
-- (plus POS payment controls). Renames preserve existing data:
--   companyName    → company
--   taxNumber      → resaleNumber
--   billingAddress → street  (the template splits the address; existing
--                             single-line addresses land in Street)
-- `notes` is dropped — it has no QuickBooks counterpart.

ALTER TABLE "Customer" RENAME COLUMN "companyName" TO "company";
ALTER TABLE "Customer" RENAME COLUMN "taxNumber" TO "resaleNumber";
ALTER TABLE "Customer" RENAME COLUMN "billingAddress" TO "street";

ALTER TABLE "Customer" DROP COLUMN "notes";

ALTER TABLE "Customer"
ADD COLUMN "city" TEXT,
ADD COLUMN "country" TEXT,
ADD COLUMN "fax" TEXT,
ADD COLUMN "mobile" TEXT,
ADD COLUMN "openingBalance" DECIMAL(18,2),
ADD COLUMN "openingBalanceDate" TIMESTAMP(3),
ADD COLUMN "qbCustomerType" TEXT,
ADD COLUMN "state" TEXT,
ADD COLUMN "website" TEXT,
ADD COLUMN "zip" TEXT;
