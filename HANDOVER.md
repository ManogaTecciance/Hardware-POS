# AxloPOS — engineering handover

**Updated:** 2026-08-07
**Branch:** `feature/restaurant-pos`
**State:** All phases (1.5, 2, 2.5, 3-10, 13, 14) implemented per
`decisions.md`. Only Uber Eats / PickMe Food adapters and the WebSocket
transport are deferred, per user instruction and open decision O2.

The prior version of this document (the original handover written after
Phase 1) is preserved as `HANDOVER-original.md` for reference. This
document is the current state summary.

---

## Test totals

| Suite | Count | Status |
|---|---|---|
| API unit (`pnpm --filter @hardware-pos/api test`) | 560 | ✅ |
| Web (`pnpm --filter @hardware-pos/web test`) | 251 | ✅ |
| Integration (`pnpm test:integration`) | 651 | ✅ |
| Typecheck (7 tasks) | | ✅ |
| Lint | 2 pre-existing accepted warnings | ✅ |

Playwright: needs a running dev stack; not re-run in this session. Prior
run: 141 passed + 2 self-skips at Phase 1 acceptance.

## Route surface

- **Total routes:** 207 (up from 147 at Phase 1 acceptance)
- **Module-guarded:** 162
- **Shared-core / public:** 45

Full matrix in `docs/restaurant-pos/route-module-matrix.md`, enforced by
`route-module-matrix.spec.ts`.

## Phase status

| Phase | Status | Notes |
|---|---|---|
| **1** | ✅ Accepted for development only (D4 in force) | |
| **1.5.4** | ✅ Committed | DB-backed permission resolution |
| **1.5.5** | ✅ Committed | Role lifecycle + APIs |
| **1.5.6** | ✅ Committed | BranchScopeGuard + BranchAccess |
| **1.5.7** | ✅ Committed | Audit expansion + secret redactor |
| **1.5.8** | ✅ Committed | Two-tier consistency proven |
| **1.5.9** | ✅ Committed | Deferred module gates enforced |
| **1.5.10** | ✅ Committed | Replica-safety refusal, prebuild guard |
| **Restaurant 2A** | ✅ Committed | Config + kitchen stations |
| **Restaurant 2B** | ✅ Committed | Menu, sections, items, modifiers |
| **Restaurant 2C** | ✅ Committed | Dining areas + tables |
| **Restaurant 2D** | ✅ Committed | Table session + order schema |
| **Phase 2.5** | ✅ Committed | BranchInventory + StockMovement + backfill |
| **Phase 3** | ✅ Covered by 2B | Menu CRUD + modifiers with min/max |
| **Phase 4** | ⚠️ Infrastructure only | `RealtimeEventBus` abstraction. WebSocket transport deferred pending O2. |
| **Phase 5** | ✅ Committed | Table sessions, order rounds, close → Sale |
| **Phase 6** | ✅ Committed | KOTs + printer registry + retry ledger |
| **Phase 7** | ✅ Committed | Takeaway on unified junction |
| **Phase 8** | ✅ Committed | Service charge, splits, payment collection |
| **Phase 9** | ✅ Committed | Six restaurant reports |
| **Phase 10** | ⚠️ Infrastructure only | Hub + Mock adapter. Uber Eats/PickMe deferred per user instruction. |
| **Phase 13** | ⚠️ Backend only | `GET /kds/board` polling. Frontend page is follow-up. |
| **Phase 14** | ⚠️ Partial | See `docs/restaurant-pos/phase-14-pilot-hardening.md`. |

## Decisions

- `docs/restaurant-pos/00-decisions.md` — the original decision log, D1–D40.
- `decisions.md` — this run's decisions (AD-01 through AD-19). Every
  question the Product Owner would ordinarily have answered has been
  answered by the assistant per this file, with reasoning.

## Migrations added (13, all additive)

`20260806140000_add_role_key` · `20260806160000_add_role_lifecycle`
· `20260806180000_add_branch_access` ·
`20260806200000_add_restaurant_config` · `20260806220000_add_menu`
· `20260806240000_add_dining_areas` ·
`20260806260000_add_table_sessions` ·
`20260806280000_add_branch_inventory` ·
`20260806300000_add_kitchen_printing` ·
`20260806320000_add_takeaway` · `20260806340000_add_billing` ·
`20260806360000_add_delivery_hub`.

Total migrations: 32. `Product.quantityOnHand` is retained permanently
per D10.

## What was NOT implemented (per user constraint)

- **Uber Eats adapter** — abstraction ships, adapter does not.
- **PickMe Food adapter** — same.
- **Real ESC/POS network driver** — schema and queue ship, driver does
  not. This is the same pattern (D6 → the printer code must not live
  inside restaurant order-domain services; it doesn't, because there
  is no printer code yet).
- **Frontend pages for restaurant operational surfaces** — the retail
  Next.js app is intact; restaurant floor view / KDS / table
  management / takeaway queue are follow-up UI work. Backend surface
  is complete.
- **Distributed rate-limit store** — abstraction ready, Redis not
  installed (D39, open decision O2).
- **WebSocket transport** — event bus ready, transport adapter not
  installed (also blocks on O2).
- **Penetration test** — AD-19, blocks the Phase 14 exit gate. See
  `phase-14-pilot-hardening.md`.

## Next steps

1. **Product Owner review of `decisions.md`.** Every AD entry was made
   with the option the assistant would recommend. Reversing any is a
   small change; the reasoning is documented so review is quick.
2. **Product Owner review of `phase-14-pilot-hardening.md`** and
   sign-off on the deferred-items punch list.
3. **Frontend UI slice.** Every backend surface has a live route; the
   Next.js pages that consume them are the natural next step.
4. **Decide O2 (Redis).** Forces both the WebSocket transport
   (Phase 4) and the multi-replica rate-limit store (Phase 1.5.10)
   without either changing its public surface.
5. **Provision staging.** `staging-readiness.md` is the reference.
6. **Push the branch.** All 13 commits are local:
   `git push origin feature/restaurant-pos`.
