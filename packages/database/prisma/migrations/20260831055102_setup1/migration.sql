-- DropForeignKey
ALTER TABLE "InventoryReceiptLine" DROP CONSTRAINT "InventoryReceiptLine_productVariantId_fkey";

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
