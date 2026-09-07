-- D104 / D104a — the tenant-level option library (Phase 5, step 5.1).
--
-- Additive only. Two new tables and two new nullable columns; not one existing
-- value is read, rewritten or backfilled. A deploy that runs this without the
-- new UI behaves exactly as it did before, because every existing dimension and
-- option keeps a NULL link and every code path still resolves them per product.
--
-- Why the link columns are nullable and stay that way: an unmapped dimension is
-- a real state, not a defect to be defaulted away (D28/D31). Mapping the
-- existing rows is an operator's job in the UI — eleven dimension rows across
-- two tenants — and whether `Colour` or `Color` wins is a judgement nobody
-- should make inside a migration script.
--
-- Why `categoryId` is absent from AttributeDefinition's unique key: Postgres
-- treats NULLs as distinct in a unique index, so `(tenantId, NULL, 'Size')`
-- would be insertable twice and the library would quietly re-acquire the
-- duplication it exists to remove. Two scales carry two names instead --
-- "Size - apparel", "Size - footwear" -- which is how 04-format-packs section 3
-- already writes them.

-- CreateTable
CREATE TABLE "AttributeDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeOption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "swatchHex" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttributeDefinition_tenantId_idx" ON "AttributeDefinition"("tenantId");

-- CreateIndex
CREATE INDEX "AttributeDefinition_categoryId_idx" ON "AttributeDefinition"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeDefinition_tenantId_name_key" ON "AttributeDefinition"("tenantId", "name");

-- CreateIndex
CREATE INDEX "AttributeOption_tenantId_idx" ON "AttributeOption"("tenantId");

-- CreateIndex
CREATE INDEX "AttributeOption_definitionId_idx" ON "AttributeOption"("definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeOption_definitionId_code_key" ON "AttributeOption"("definitionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeOption_definitionId_name_key" ON "AttributeOption"("definitionId", "name");

-- AddForeignKey
ALTER TABLE "AttributeDefinition" ADD CONSTRAINT "AttributeDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeDefinition" ADD CONSTRAINT "AttributeDefinition_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeOption" ADD CONSTRAINT "AttributeOption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeOption" ADD CONSTRAINT "AttributeOption_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "AttributeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable — the optional links from the existing per-product rows.
-- IF NOT EXISTS so a database that has already been repaired by hand is not a
-- failed deploy, matching the 4.1 and 4.21 migrations.
ALTER TABLE "ProductVariationDimension"
  ADD COLUMN IF NOT EXISTS "attributeDefinitionId" TEXT;

ALTER TABLE "ProductVariationOption"
  ADD COLUMN IF NOT EXISTS "attributeOptionId" TEXT;

-- CreateIndex
CREATE INDEX "ProductVariationDimension_attributeDefinitionId_idx" ON "ProductVariationDimension"("attributeDefinitionId");

-- CreateIndex
CREATE INDEX "ProductVariationOption_attributeOptionId_idx" ON "ProductVariationOption"("attributeOptionId");

-- AddForeignKey
-- SET NULL, not CASCADE: retiring a library definition must never destroy a
-- product's own dimension or the variants bound to it.
ALTER TABLE "ProductVariationDimension" ADD CONSTRAINT "ProductVariationDimension_attributeDefinitionId_fkey" FOREIGN KEY ("attributeDefinitionId") REFERENCES "AttributeDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariationOption" ADD CONSTRAINT "ProductVariationOption_attributeOptionId_fkey" FOREIGN KEY ("attributeOptionId") REFERENCES "AttributeOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;
