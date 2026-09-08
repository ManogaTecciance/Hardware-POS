-- D92 — the synthetic walk-in area gets a name a person can read.
--
-- A DiningArea row's `name` IS its display name, so `__walk_in__` was never
-- only internal: it appeared verbatim as a chip in the waiter's table picker
-- and on the floor plan. Data only — no column, table or constraint changes.
--
-- Guarded by NOT EXISTS because of `@@unique([branchId, name])`: a branch that
-- already has a floor called "Walk In" would abort the whole migration on a
-- unique violation. Such a branch keeps the old name, and the service reuses
-- the row by its synthetic position (999) rather than by name, so nothing
-- breaks there — see `ensureWalkInTable`.
UPDATE "DiningArea" a
SET name = 'Walk In'
WHERE a.name = '__walk_in__'
  AND NOT EXISTS (
    SELECT 1
    FROM "DiningArea" b
    WHERE b."branchId" = a."branchId"
      AND b.name = 'Walk In'
  );
