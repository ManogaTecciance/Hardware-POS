-- D104 — one joined table, several tabs.
--
-- A tab's own name, so two parties sharing one arrangement are distinguishable
-- on the kitchen ticket, the bill and the floor. Null = the table's name stands
-- alone, which is exactly what every existing row already means: before this
-- record a table could carry only one live session, so a tab never needed
-- telling apart from a sibling it could not have.
--
-- Purely additive and nullable. No backfill, no DROP, no SET NOT NULL.
ALTER TABLE "TableSession" ADD COLUMN "tabName" TEXT;
