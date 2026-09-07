# Phase 8 — verification pass (`8.10`)

**Run 2026-09-07.** Branch `feature/retail-template`, nothing pushed.

## What this pass is, and what it is not

Every flow below was exercised against a **real PostgreSQL database over real
HTTP**, through the application's real guards — `JwtAuthGuard`, `RolesGuard`,
`PermissionsGuard` and `ModuleAccessGuard` are `APP_GUARD`s and only run on an
HTTP request, so a 403 for a cashier is a property of the wiring that no
service-level test can reach. The evidence is
`apps/api/test/integration/specs/phase-8-acceptance.spec.ts`, which is a
permanent regression suite rather than a one-off script.

**It is not a human looking at the screens.** No browser was driven, no
screenshot taken, and nobody clicked anything. What that leaves unverified is
listed at the end, plainly, rather than folded into a "PASS".

---

## 1. Phases 1–7 regression

| # | Check | Expected | Actual | Result |
|---|---|---|---|---|
| R1 | Full integration suite, every spec | All green | **975 / 976**; the single failure was `auth-hardening › the QuickBooks OAuth callback stays reachable without a session`, `TypeError: fetch failed` | **PASS (environmental)** |
| R2 | Prove R1's failure is the environment, not a regression | The spec follows a redirect to the web app on `localhost:3000`; with the dev stack stopped the socket refuses | Started a stub listener on 3000 and re-ran: **27 / 27 green, including that test** | **PASS** |
| R3 | API unit suite | 10 pre-existing failures (Windows path separators in four architectural analysers), no new ones | 10 failures, 1072 passed | **PASS (baseline held)** |
| R4 | Web unit suite | 6 pre-existing failures, same cause | 6 failures, 642 passed | **PASS (baseline held)** |
| R5 | Web production build — every page compiles and prerenders | Build succeeds, `/reports` and `/stock-takes` present | Build succeeded; `/reports` 6.61 kB, `/stock-takes` 8.6 kB | **PASS** |
| R6 | `tsc --noEmit` on api, web and e2e | Clean | Clean, all three | **PASS** |
| R7 | Schema and migrations agree before either was committed | `migrate diff` reports "This is an empty migration" | Reported exactly that, for both `8.7` and `8.9` | **PASS** |

---

## 2. Phase 8, flow by flow

Each row is one HTTP exchange against a seeded Retail tenant with real role
templates. "Cashier" and "Owner" are real JWTs for the fixture users, minted the
way `AuthService` mints them.

### `8.3` Sales by variant — `GET /sales/reports/by-variant`

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Owner reads a March range after one completed sale of 2 × Medium at 1000, tax 360 | One row, `Medium`, revenue `"2000.00"`, tax `"360.00"`, as **strings** | Exactly that | **PASS** |
| Cashier reads the same URL | 403 | 403 | **PASS** |
| `?from=nonsense` | 400 from the DTO | 400 | **PASS** |
| The literal path is not captured by `GET /sales/:id` | Not 404 | 200 | **PASS** |

### `8.4` Tax by rate — `GET /sales/reports/tax-by-rate`

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Owner reads the same range | One row: `18%`, taxable `"2000.00"`, tax `"360.00"`, `hasUnattributed: false` | Exactly that | **PASS** |
| Cashier | 403 | 403 | **PASS** |

### `8.5` Margin — `GET /sales/reports/margin`

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Owner, variant `averageCost` 600, 2 sold at 1000 | cost `"1200.00"`, margin `"800.00"`, `costSource: VARIANT_AVERAGE`, total margin 40.00% | Exactly that, `unknownCost.rows: 0` | **PASS** |
| Cashier | 403 | 403 | **PASS** |

### `8.6` Slow movers — `GET /sales/reports/ageing`

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Owner, 20 on hand received 200 days ago, never sold, threshold 90 | One row, `ageBasis: FIRST_RECEIPT`, `ageDays ≥ 199`, stock value `"12000.00"` | Exactly that; `hasStockLedger: true` | **PASS** |
| `?thresholdDays=1.5` | 400 | 400 | **PASS** |
| Cashier | 403 | 403 | **PASS** |

### `8.7` Stock count — `POST /stock-takes`

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Owner counts 14 where the books say 20 | 201, `SC-000001`, variance `-6.000`, value `"-3600.00"`, and `BranchInventory` now reads 14 | Exactly that | **PASS** |
| Cashier attempts the same count | 403 **and nothing moves** | 403; shelf still 20 | **PASS** |
| Empty `lines` | 400 | 400 | **PASS** |
| `countedQuantity: -1` | 400 | 400 | **PASS** |
| Cashier reads the count history | 200 — reading is `product:read`, which a cashier holds | 200 | **PASS** |

### `8.8` Hold and resume

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Cashier holds 2 × Medium | Draft created, status `DRAFT` | 201, `DRAFT` | **PASS** |
| Cashier lists held baskets | The held sale, and only it | Exactly one, matching id | **PASS** |
| Cashier resumes it and pays cash | Sale completes | `COMPLETED` | **PASS** |
| Cashier lists again | Empty — a paid basket is not held | `[]` | **PASS** |
| Cashier discards a held basket | 204 | 204 | **PASS** |
| Cashier discards a **completed** sale by its real id | 404, sale untouched | 404, sale still there | **PASS** |

### `8.9` Brands

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Owner creates "Acceptance Label" | 201 | 201 | **PASS** |
| Cashier reads brands | 200, sees it | 200, sees it | **PASS** |
| Cashier creates a brand | 403, **and no row is written** | 403; brand count still 1 | **PASS** |
| Owner filters products by brand | Only the branded product | Exactly one, the right one | **PASS** |
| Body carries an extra `tenantId` | 400 (`forbidNonWhitelisted`) | 400 | **PASS** |

### The rail as a whole

| Flow | Expected | Actual | Result |
|---|---|---|---|
| Each of the 7 Phase 8 GET routes, as an owner | 200 | 200, all seven | **PASS** |
| Each of them with no token | 401 | 401, all seven | **PASS** |

**23 / 23 acceptance assertions green.**

---

## 3. What is still NOT verified

Stated as gaps, not as risks-to-be-managed.

1. **Nobody has looked at the screens.** No browser was opened. The web build
   proves every page compiles and server-renders; it proves nothing about
   layout, contrast, focus order, mobile width, or whether a button is where a
   cashier's thumb expects it. Phase 4 found eight defects by using the app that
   828 green tests had not — that history applies here unchanged.
2. **No Playwright run.** The suite exists (`apps/e2e`, 18 specs, real Chrome)
   and would give genuine browser coverage, but it drives the app against the
   **development database**, which holds the pilot tenant's real data — 20
   completed sales, 43 sale lines, the reissued barcodes. Running it would write
   test products and sales into that data. Not done without an explicit
   instruction.
3. **No printed output was inspected.** Label sheets (`5.7`) and the exchange
   A4 note (`7.x`) render through the print queue; nobody has held the paper.
4. **Multi-branch retail is untested and partly refused.** `LocalInventoryProvider`
   still refuses a multi-branch LOCAL tenant outright (D10 Phase 2.5 outstanding).
   Every Phase 8 flow was verified single-branch, which is the pilot shape.
5. **Concurrency was not exercised at the HTTP level.** Two simultaneous counts
   of the same shelf, or two tills resuming the same held basket, are covered by
   database constraints and predicates that have unit and integration proofs,
   but no load was applied through the wire.
6. **`hasStockLedger: false`, the empty-report and the error states were checked
   in tests, not on screen.** The distinction between "nothing is slow-moving"
   and "this tenant keeps no stock ledger" is asserted server-side; that it
   *reads* clearly to a manager is unverified.

---

## 4. What this pass changed

Nothing. No source file was modified during verification; the one failure
investigated (R1/R2) was proven environmental by reproducing and then removing
the environmental cause.
