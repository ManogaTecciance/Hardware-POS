-- D101 — the 86 switch. One nullable column: null = available, a timestamp =
-- sold out since then. Purely additive; every existing row stays available,
-- which is what every existing row already meant.
ALTER TABLE "Product" ADD COLUMN "soldOutAt" TIMESTAMP(3);
