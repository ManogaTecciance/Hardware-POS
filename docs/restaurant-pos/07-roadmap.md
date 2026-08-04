# Roadmap

Estimates are engineering days for one developer, excluding review cycles.

| Phase | Scope | Est. | Exit gate |
|---|---|---|---|
| 0 | Repository and architecture audit | done | audit approved |
| **1** | Platform modularisation + optional QuickBooks | **~13 d** | Tile Shop provably unchanged; a Restaurant tenant creates zero `SyncJob` rows |
| 2 | DB-backed permissions, restaurant roles, branch scoping, audit expansion, settings-cache fix | 1.5 wk | Waiter role works; cross-branch access denied |
| 2.5 | Branch-scoped inventory (`BranchInventory` + `StockMovement`) — decision D10 | 1.5 wk | branch rollup equals sum of branches; `Product.quantityOnHand` preserved |
| 3 | Menu, modifiers, channel pricing, availability windows | 2 wk | full menu CRUD + modifier min/max validation |
| 4 | Dining areas, tables, kitchen stations, floor view, **WebSocket transport** (D7) | 2 wk | live floor plan; screens resynchronise after reconnect |
| 5 | Table sessions, restaurant orders, **multiple order rounds** | 2.5 wk | scenarios 8-11, 15 |
| 6 | **KOT/BOT**, printer registry, station routing, ESC/POS (D6) | 2.5 wk | scenario 20 — printer failure never loses an order |
| 7 | Takeaway | 1 wk | end-to-end create → prepare → handover → complete |
| 8 | Billing, service charge (D8), splits, mixed payments, manager voids | 2 wk | scenarios 13, 14, 18 |
| 9 | Basic restaurant reports | 1 wk | 8-10 core reports |
| — | **RELEASE 1** | | pilot restaurant live |
| 10 | Online Orders Integration Hub + Mock adapter + webhook infrastructure | 2.5 wk | scenario 12 |
| 11 | Uber Eats adapter (D9 — no production claim without certification) | 2 wk | sandbox verified |
| 12 | PickMe Food adapter (D9) | 2 wk | sandbox verified |
| 13 | Kitchen Display System | 2 wk | station board live |
| 14 | Pilot hardening, performance, security, rate limiting, token-storage redesign | 2 wk | penetration test clean |

## Release 1 contents

Restaurant tenant profile · QuickBooks optional · dining areas · table management ·
waiter assignment · guest count · multiple order rounds · menu items · modifiers ·
special instructions · KOT/BOT printing · kitchen station routing · running table
bill · preliminary bill · restaurant billing · service charge · taxes · split
billing · mixed payments · takeaway · basic restaurant reports · users and
permissions · branding · audit logging.

**Deliberately not in Release 1:** advanced KDS · ingredient-level recipes · AI
forecasting · loyalty · reservations · customer mobile applications · QR ordering ·
Uber Eats production certification · PickMe production certification.

## Critical-path warnings

- **Phase 6 (printing) is the largest net-new engineering item in Release 1** —
  larger than table management. There is no printing infrastructure beyond
  browser `window.print()` today: no printer registry, no network/ESC-POS
  transport, no station routing, no reprint marking, no print-failure recovery.
- **Phase 4 pulls the WebSocket transport forward** rather than polling and then
  rewriting it at Phase 13. The floor view, the KDS, and online-order boards all
  need it.
- **Socket.IO across replicas needs a shared adapter** (decision D11 + open
  question O2). Decide "Redis: yes or no" *before* Phase 4.
- **Phase 2.5 must precede Phase 5.** Restaurant table sessions that deplete stock
  on a tenant-wide counter would entrench the multi-branch defect.
- **Staging does not exist.** Per decision D4 this blocks production deployment,
  not local development — but it blocks it absolutely, from Phase 1 onward.

## Phase 1 slice order

| # | Slice | Depends on | Est. | Status |
|---|---|---|---|---|
| 0 | Deployment & repository safety | — | 0.5 d | ✅ implemented |
| 1 | Documentation reorganisation | 0 | 0.5 d | ✅ implemented |
| 2 | Integration-test harness | 0 | 1.5 d | ✅ implemented |
| 3 | Characterisation tests for existing behaviour | 2 | 1.5 d | ✅ implemented |
| 4 | Platform data model (profile, modules, migration, guard) | 2 | 2 d | ⏸ awaiting approval |
| 5 | Provider ports (inert — no call-site changes) | 4 | 1.5 d | ⏸ awaiting approval |
| 6 | Provider adoption (rewire sales, returns, products) | 3, 5 | 2 d | ⏸ awaiting approval |
| 7 | Security & consistency fixes | 4 | 1.5 d | ⏸ awaiting approval |
| 8 | Frontend modularisation | 4, 7 | 2 d | ⏸ awaiting approval |

Slices 0-2 carry no behaviour risk. **Slice 3 must precede Slices 5 and 6** —
characterisation tests written after a refactor document the new behaviour, not the
old, and would be worthless as a baseline. Slice 5 lands ports with no call-site
changes so the risky rewire in Slice 6 is a small, reviewable diff. **Slice 6 is
the only slice that can break the Tile Shop**, and it is fenced by Slices 2 and 3.
