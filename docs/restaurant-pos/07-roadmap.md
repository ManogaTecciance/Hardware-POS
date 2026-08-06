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

The plan below is the original sequencing decision and is unchanged. **Actual
repository status is a separate table** — see *Repository status* — because a plan
that also claims to be a status report ends up being neither.

| # | Slice | Depends on | Est. |
|---|---|---|---|
| 0 | Deployment & repository safety | — | 0.5 d |
| 1 | Documentation reorganisation | 0 | 0.5 d |
| 2 | Integration-test harness | 0 | 1.5 d |
| 3 | Characterisation tests for existing behaviour | 2 | 1.5 d |
| 4 | Platform data model (profile, modules, migration, guard) | 2 | 2 d |
| 5 | Provider ports (inert — no call-site changes) | 4 | 1.5 d |
| 6 | Provider adoption (rewire sales, returns, products) | 3, 5 | 2 d |
| 7 | Security & consistency fixes | 4 | 1.5 d |
| 8 | Frontend modularisation | 4, 7 | 2 d |
| 9 | Phase 1 completion and demo readiness | 8 | 1 d |

Slices 0-2 carry no behaviour risk. **Slice 3 must precede Slices 5 and 6** —
characterisation tests written after a refactor document the new behaviour, not the
old, and would be worthless as a baseline. Slice 5 lands ports with no call-site
changes so the risky rewire in Slice 6 is a small, reviewable diff. **Slice 6 is
the only slice that can break the Tile Shop**, and it is fenced by Slices 2 and 3.

## Repository status

What is actually in this repository, on branch `feature/restaurant-pos`. This
section describes the tree, not an approval state — the previous version of it
carried "awaiting approval" against work that had been merged for a week, which is
the failure mode it now exists to prevent.

### What the status words mean

They are deliberately not synonyms, and a slice can hold several at once.

| Word | Means |
|---|---|
| **Planned** | A decision record describes it. No code. |
| **Not started** | Scheduled, not begun. Distinct from *planned* only in that the plan is settled. |
| **Implemented** | The code exists in the working tree and its own tests pass. |
| **Committed** | It is in a commit on this branch, with a SHA. |
| **Pushed** | That commit exists on `origin/feature/restaurant-pos`. |
| **Verified** | `lint`, `typecheck`, `test`, `test:integration` and `build` pass, and the Playwright suite was run against a live stack. |

### Phase 1

| # | Slice | Status | Commit |
|---|---|---|---|
| 0-3 | Deployment safety, docs, integration harness, characterisation tests | implemented · committed · pushed · verified | `39a1bc4` |
| 3.5 | Deterministic tenant-scoped authentication | implemented · committed · pushed · verified | `bfa77a1` |
| 4 | Platform data model (profile, modules, migration, guard) | implemented · committed · pushed · verified | `1c6b24e` |
| 5, 5.5 | Provider ports (inert) | implemented · committed · pushed · verified | `1d15f4c` |
| 6 | Provider adoption — sales | implemented · committed · pushed · verified | `ea52d01` |
| 6 | Provider adoption — returns | implemented · committed · pushed · verified | `8ff286b` |
| 6 | Provider adoption — inventory | implemented · committed · pushed · verified | `a162b5f` |
| 6 | Provider adoption — catalogue sync | implemented · committed · pushed · verified | `6774926` |
| 6C-B | Provider-aware catalogue status (frontend) | implemented · committed · pushed · verified | `062f931` |
| 7 | Security & consistency (throttling, workspace login, shared permissions) | implemented · committed · pushed · verified | `cc7fb8b` |
| 8 | Frontend modularisation (module-aware workspaces) | implemented · committed · pushed · verified | `3c5c916` |
| 9 | Phase 1 completion and demo readiness | implemented · verified · **committed in the commit carrying this line** | — |

Slice 9's results, the development workspaces and the known limitations are in
[`09-phase-1-acceptance.md`](./09-phase-1-acceptance.md). *Verified* there means
what the table above defines: `lint`, `typecheck`, `test`, `test:integration` and
`build` pass, and Playwright was run serially against a live stack. One case,
`QB-006/007/008`, is flaky against the live QuickBooks sandbox — it failed on a
timeout in 2 of 7 runs. That is recorded rather than rounded off.

### Restaurant phases

| Phase | Status |
|---|---|
| 2 — DB-backed permissions, restaurant roles, branch scoping | not started |
| 2.5 — Branch-scoped inventory | not started |
| 3 — Menu, modifiers, channel pricing | not started |
| 4 — Dining areas, tables, kitchen stations, WebSocket transport | not started |
| 5 — Table sessions, restaurant orders, order rounds | not started |
| 6 — KOT/BOT, printer registry, ESC/POS | not started |
| 7 — Takeaway | not started |
| 8 — Restaurant billing, service charge, splits | not started |
| 9 — Restaurant reports | not started |
| 10-14 — Online orders, delivery adapters, KDS, hardening | not started |

**No restaurant operational feature is implemented.** Slice 8 added navigation,
module gating and route shells for Menu, Tables, Takeaway and Kitchen. Each shell
states on screen that the feature is not implemented, and no restaurant domain
model exists in the schema — no `DiningArea`, `RestaurantTable`, `TableSession`,
`RestaurantOrder`, `OrderRound`, `Menu`, `ModifierGroup`, `KitchenTicket` or
`TakeawayOrder`. Ordering, kitchen routing and restaurant billing are **not
started**.
