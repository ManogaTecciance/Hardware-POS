-- D197 — a restaurant order has a call number the counter can say out loud.
--
-- `RestaurantOrder.orderNumber` (`RO-000120`) is tenant-wide and only grows:
-- the right permanent identifier, and the wrong thing to shout across a
-- takeaway counter. The industry's answer is a second, short number that
-- restarts every trading day — Toast's check number, Square's order number.
--
-- `callNumber` is that number; `callDay` is the business day (tenant zone,
-- `YYYY-MM-DD`) it counts within. Allocation rides on `DocumentSequence`
-- under the key `ORDER_CALL:<branchId>:<day>` — the same atomic upsert every
-- document number uses, so two tills opening an order at the same instant
-- cannot both be #47.
--
-- ## Data safety
--
-- Purely additive. Both columns are nullable and NO existing row is touched:
-- an order minted before D197 keeps reading by its `RO-` number everywhere
-- (every screen falls back to it when `callNumber` is null). Backfilling a
-- call number onto history would invent numbers nobody was ever handed.
--
-- The unique index tolerates the nulls: Postgres treats NULLs as distinct in
-- a unique index, so every legacy row satisfies it, while two live orders on
-- one branch and day can never share a number.

-- AlterTable
ALTER TABLE "RestaurantOrder" ADD COLUMN "callNumber" INTEGER;
ALTER TABLE "RestaurantOrder" ADD COLUMN "callDay" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantOrder_branchId_callDay_callNumber_key"
  ON "RestaurantOrder"("branchId", "callDay", "callNumber");
