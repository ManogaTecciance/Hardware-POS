# AxloPOS Restaurant POS — canonical documentation

This directory is the **implementation authority** for turning AxloPOS from a
single-vertical Hardware/Tile-Shop POS into a configurable, modular, multi-tenant
SaaS POS platform that also serves restaurants.

It supersedes [`../restaurant-backend-plan.md`](../restaurant-backend-plan.md),
which is retained as historical reference and carries a superseded notice.

## Reading order

| # | Document | Read it when |
|---|---|---|
| 1 | [`00-decisions.md`](./00-decisions.md) | Always first — the Product Owner decision log. Nothing here overrides it. |
| 2 | [`phase-00-audit.md`](./phase-00-audit.md) | You need ground truth about what the codebase actually does today. |
| 3 | [`01-platform-architecture.md`](./01-platform-architecture.md) | Working on business profiles, module gating, or navigation. |
| 4 | [`02-provider-abstractions.md`](./02-provider-abstractions.md) | Touching inventory, accounting, printing, or delivery integrations. |
| 5 | [`03-domain-model.md`](./03-domain-model.md) | Adding restaurant tables/models. |
| 6 | [`04-permissions-and-roles.md`](./04-permissions-and-roles.md) | Adding a permission, role, or guard. |
| 7 | [`05-testing-strategy.md`](./05-testing-strategy.md) | Writing any test, especially a regression test. |
| 8 | [`06-migration-and-rollout.md`](./06-migration-and-rollout.md) | Writing a migration or deploying. **Contains the deployment runbook.** |
| 9 | [`07-roadmap.md`](./07-roadmap.md) | Planning, sequencing, or checking what phase we are in. |
| 10 | [`phase-01-plan.md`](./phase-01-plan.md) | Implementing Phase 1. |

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository and architecture audit | ✅ Complete — [`phase-00-audit.md`](./phase-00-audit.md) |
| 1 | Platform modularisation, optional QuickBooks | 🟡 In progress — Slices 0-3 implemented, Slice 4+ awaiting approval |
| 2 | DB-backed permissions, restaurant roles, branch scoping | ⬜ Not started |
| 2.5 | Branch-scoped inventory (`BranchInventory` + `StockMovement`) | ⬜ Not started |
| 3 | Restaurant menu and modifiers | ⬜ Not started |
| 4 | Dining areas and tables | ⬜ Not started |
| 5 | Table sessions and multiple order rounds | ⬜ Not started |
| 6 | KOT/BOT printing and kitchen routing | ⬜ Not started |
| 7 | Takeaway | ⬜ Not started |
| 8 | Restaurant billing and split payments | ⬜ Not started |
| 9 | Basic restaurant reports | ⬜ Not started |
| — | **Release 1** | ⬜ |
| 10 | Online Orders Integration Hub (mock adapter) | ⬜ Not started |
| 11 | Uber Eats adapter | ⬜ Not started |
| 12 | PickMe Food adapter | ⬜ Not started |
| 13 | Kitchen Display System | ⬜ Not started |
| 14 | Pilot, performance, security, production hardening | ⬜ Not started |

## Non-negotiable engineering rules

These apply to every phase and every pull request.

1. **Additive migrations only.** New models, new nullable columns, appended enum
   values. No `DROP`, no `ALTER COLUMN … NOT NULL`, no rename, no repurposing of
   an existing column, without an explicit approved data-migration strategy.
2. **The existing Tile Shop must keep working.** If a change requires editing an
   existing behavioural test, the change is not backward-compatible and must be
   redesigned. Test infrastructure and fixtures may be extended; existing
   behavioural assertions may not be weakened or removed.
3. **No `if (businessType)` inside shared modules.** Vertical behaviour lives in
   vertical modules or behind a provider port.
4. **Server-authoritative money and state.** Client-supplied totals are never
   trusted. Tenant identity is derived from the authenticated server-side
   context, never from a request-supplied value on an authenticated route.
5. **Never depend on process-local cache state for correctness.** Assume more
   than one API replica.
6. **QuickBooks stays optional, never removed.** No QuickBooks column, module, or
   workflow is deleted.
7. **Production migrations are a separate, approved deployment step.** See
   [`06-migration-and-rollout.md`](./06-migration-and-rollout.md).
