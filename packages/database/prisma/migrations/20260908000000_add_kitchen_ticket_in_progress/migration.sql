-- D106 — the kitchen board gains a Preparing state.
-- Additive only: one new enum value; no default changes, no rows touched.
-- IF NOT EXISTS keeps a re-run harmless on a database that already has it.
ALTER TYPE "KitchenTicketStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
