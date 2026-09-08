-- D66 — channel-scoped assortments (convergence plan §8.5, Phase 9): which
-- sales channels a collection applies to. Empty = all channels, which is
-- exactly what every existing row means unchanged — purely additive. (The
-- recurring D44 InventoryReceiptLine FK drift pair is stripped, as always.)

-- AlterTable
ALTER TABLE "Menu" ADD COLUMN     "channels" "OrderChannel"[] DEFAULT ARRAY[]::"OrderChannel"[];
