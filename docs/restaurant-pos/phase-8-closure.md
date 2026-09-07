# Phase 8 — closure (`8.11`)

**2026-09-07.** Branch `feature/retail-template`, 24 commits ahead of
`origin/feature/retail-template`, **nothing pushed**.

Phase 8 is the last phase in the plan. This file is the completion checklist and
the handover of what remains.

---

## 1. Completion checklist

| | Item | State |
|---|---|---|
| ☑ | Every step `8.0`–`8.11` implemented | 11 / 11 |
| ☑ | Every step has integration tests against a real database | yes |
| ☑ | Every new route classified in `route-module-matrix.spec.ts` **and** its document | 305 → 308 routes, 209 → 211 guarded and ungated as declared |
| ☑ | Every decision that needed a record has one | `D108`, `D109`, `D110`, `D111`, `D112` |
| ☑ | No migration without a decision record | `8.7` → `D111`, `8.9` → `D112`; both verified with `migrate diff` before commit |
| ☑ | Schema and migrations agree | "This is an empty migration", both times |
| ☑ | No restaurant source file edited | Checked, not assumed: `git diff --name-only b703721~1..HEAD` filtered for `restaurant|menu|dining|kitchen|table-session|takeaway|billing|delivery` returns **three files, all documentation** — `docs/restaurant-pos/{00-decisions,route-module-matrix,phase-8-verification}.md`, which live under a folder that happens to be named for Phase 1. **Zero source files** |
| ☑ | The protected drift folder untouched | `packages/database/prisma/migrations/20260828081727/` still untracked, never staged |
| ☑ | Test baselines held | API unit 10 failures, web unit 6 — the same pre-existing Windows path-separator failures as before the phase |
| ☑ | Full integration suite | 975 / 976; the one failure proven environmental |
| ☑ | Acceptance pass over real HTTP | 23 / 23 |
| ☑ | Web production build | succeeds, every page |
| ☑ | Docs updated | `PROGRESS.md`, `00-README.md`, `02-implementation-phases.md`, `00-decisions.md`, route matrix, this file, `phase-8-verification.md` |
| ☐ | **A human has used the app** | **NOT DONE** — the deferred UI pass |
| ☐ | Pushed | **NOT DONE** — held at the PO's instruction until the UI pass |

---

## 2. What Phase 8 added

| Step | What a shop can now do | Decision |
|---|---|---|
| `8.2` | Open a Reports screen that is about a shop, not a restaurant | — |
| `8.3` | See what sold, by product and by size, best sellers first | — |
| `8.4` | Reconcile tax at each rate against what was charged | — |
| `8.5` | See what the goods that sold actually earned | `D110` |
| `8.6` | Find stock that has not moved in ninety days, and what it is worth | — |
| `8.7` | Count a shelf and correct the books, auditably | `D111` |
| `8.8` | Put a basket down and pick it up again | — |
| `8.9` | Filter and report by brand, as an entity rather than a string | `D112` |

`8.1` handed **A8** to the restaurant team as `RT-02` and kept its rule on the
retail side as a mutation-proven tripwire (`D108`), because the defect lives only
in `restaurant-reports.service.ts` and editing it would breach the PO's
constraint and this plan's own guarantee.

---

## 3. Known limitations, carried forward

These are things the code does not do, stated so nobody has to re-derive them.

1. **Margin is costed at today's weighted average** (`D110`), not the cost on the
   day of the sale. Exact costing means freezing a unit cost onto `SaleItem` at
   sale time — a migration and a change to the write path every tenant runs
   through — and would still not answer for sales already taken. The screen says
   so in words.
2. **A held basket has no label.** "Mrs Silva" or "fitting room 3" would need a
   column; baskets are identified by number, time, cashier, customer and
   contents. Deliberate, and the cheapest thing on this list to add.
3. **Reports are tenant-wide.** No per-branch filter, matching the existing
   `GET /sales/report` beside them. A per-branch reading is a different question
   with its own parameter and its own tests.
4. **`8.6` reads `BranchInventory` only.** A tenant with no per-branch ledger
   gets `hasStockLedger: false` rather than a false all-clear, but the report
   cannot describe stock held in an external system.
5. **Stock counts use `product:manage`.** D44's argument for `inventory:receive`
   — a floor manager who counts need not also edit the catalogue — applies
   equally here and is not acted on because nobody has asked. `inventory:count`
   is the natural next step.
6. **Multi-branch retail is still refused** by `LocalInventoryProvider` for
   product-level operations. D10's Phase 2.5 is outstanding and is not a Phase 8
   concern.
7. **No markdown / clearance pricing.** Open question 6, answered *no* by the PO
   on 2026-09-07. Deferred, not rejected: what is given up is the *was / now*
   pair on a shelf label and a "how much did we lose to markdowns" report.

---

## 4. Handover — what someone else must do

| # | Item | Who |
|---|---|---|
| 1 | **`RT-02`** — A8 in `restaurant-reports.service.ts`: 15 float-money sites. Measured: the totals DO tie out today (zero disagreements in a million samples); the real exposure is division, which the file does not yet do but its obvious next reports will | Restaurant team *(forwarded)* |
| 2 | **`RT-01`** — the per-line tax snapshot handover | Restaurant team *(forwarded)* |
| 3 | **`2.5`** — grocery attribute schema. Closed, not parked: one `RETAIL` business type means a grocery tenant would see the clothing schema. Needs an answer before a grocery client is sold | Whoever sells one |
| 4 | **The UI pass** | A human with the app open |
| 5 | **Four architectural analysers fail on Windows** — `collectFiles` returns absolute paths where the specs expect repo-relative ones, so ten exact-set assertions cannot pass on this machine. Pre-existing, unrelated to this branch, and it makes ten tripwires read as failures instead of guarding anything | Whoever owns the testkit |

---

## 5. The push

Twenty-four commits are held locally at the PO's instruction:

> *"Do NOT push anything yet. Keep all commits local for now. We will push
> everything together only after all phases are fully implemented and manually
> tested in the UI."*

All phases are implemented. **The UI test is the remaining condition.**
