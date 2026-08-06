# Phase 1 — acceptance report

Slice 9. What was verified, how, what is knowingly incomplete, and what Phase 1
does **not** deliver. Written against commit `3c5c916` on `feature/restaurant-pos`.

This document reports results. It does not restate design decisions — those live in
[`00-decisions.md`](./00-decisions.md) — and it does not claim anything the test
output does not show.

## What Phase 1 delivers

A tenant's **business profile** decides its inventory authority, its accounting
provider and which feature modules it has. Navigation, route access and the
product screens are derived from that profile. QuickBooks became optional rather
than assumed: a Restaurant tenant runs on local inventory, posts to no accounting
system, and creates no `SyncJob` rows.

The Tile Shop is unchanged. A tenant with no profile row resolves to the
pre-Slice-4 configuration and is a supported state, not an incomplete setup.

## Verification results

Run on macOS 15, Node via pnpm 10.33, PostgreSQL 16 in Docker, against
`feature/restaurant-pos` at `3c5c916`.

| Command | Result |
|---|---|
| `pnpm lint` | **Pass** — 0 errors, 2 warnings (both pre-existing, unchanged; see *Known limitations*) |
| `pnpm typecheck` | **Pass** — 7 tasks |
| `pnpm --filter @hardware-pos/api test` | **Pass** — 25 suites, 483 tests |
| `pnpm --filter @hardware-pos/web test` | **Pass** — 11 files, 251 tests |
| `pnpm test:integration` | **Pass** — 15 suites, 540 tests, against a disposable PostgreSQL |
| `pnpm build` | **Pass** — 4 tasks |
| Playwright, serial (`--workers=1`) | **Pass** — 141 passed, 2 skipped |
| `pnpm test` (all workspaces incl. Playwright, `--concurrency=1`) | **Pass** — 5 tasks: api 483, web 251, e2e 141 passed / 2 skipped |

Playwright was run against a stack built from this commit: API on `:4100`, web on
`:3100`, the development PostgreSQL. Skipped cases are `POS-020` (the seeded owner
has no PIN) and `QB-005` (needs an expired QuickBooks token); both skip themselves
with a stated reason and neither is new.

### Required scenarios

| Scenario | Cases | Result |
|---|---|---|
| Workspace login | `WS-101`…`WS-105` | pass |
| Tile Shop navigation | `WS-301`, `WS-302` | pass |
| Restaurant navigation | `WS-401`…`WS-404` | pass |
| QuickBooks route rejection for a Restaurant tenant | `WS-501`, `WS-502`, `WS-601`, `WS-602` | pass |
| Module-disabled direct-route access | `WS-503`, `WS-504`, `WS-505`, `WS-603` | pass |
| PIN login after workspace authentication | `WS-201`, `WS-202`, `AUTH-002`, `AUTH-002b` | pass |
| Product management, QUICKBOOKS inventory | `WS-801`, plus `products.spec.ts` | pass |
| Product management, LOCAL inventory | `WS-802`, `WS-803` | pass |

Every absence assertion is paired with a positive control. The rail is read only
after it has rendered links, because navigation is derived from a profile fetched
after sign-in and an empty rail would satisfy every "should not contain" check in
the file. That guard is in `railLinkNames`, and it caught exactly that fault while
this suite was being written.

## Audits

### Tenant isolation

`WS-701`…`WS-704`, plus the integration suite's per-tenant fixtures.

- The Restaurant tenant's catalogue and the Tile Shop's catalogue share **no** ids
  (both sets non-empty — asserted, so the intersection means something).
- A Tile Shop product id read with a Restaurant token returns 403/404.
- Each tenant resolves its own profile: `RESTAURANT/LOCAL/NONE` versus
  `TILE_SHOP/QUICKBOOKS/QUICKBOOKS`.
- A PIN valid in one tenant does not authenticate on a device commissioned for the
  other (`WS-202`).

### Module guard

`route-module-matrix.spec.ts` reads Nest's own route metadata — not source text —
and classifies **every** served route as an exact set. A new, deleted, renamed or
re-gated route fails the spec by name. `ModuleAccessGuard` refusals were also
exercised over HTTP: `/quickbooks/status`, `/sync/status`, `/sync/logs`,
`/suppliers` and `/quotations` all return **403** for the Restaurant tenant, and
`/quickbooks/status` returns **200** for the Tile Shop.

Frontend gating is usability only and is documented as such in `module-gate.tsx`.
The server refuses regardless of what the sidebar drew.

### Provider combinations

`catalog-adoption.spec.ts` enumerates the whole `InventoryMode ×
AccountingProviderKind` space — 4 × 3 = 12 pairs. The 3 supported pairs are
accepted; the other 9 are refused with `UnsupportedProfileCombinationError`. This
is an allow-list, so a mode or provider added to either enum is refused until
someone decides what it pairs with.

Stock authority cannot be changed out from under existing transactions:
`assertInventoryModeTransitionIsSafe` refuses an inventory-mode change once the
tenant has any completed sale or return (`UnsafeInventoryModeTransitionError`,
covered in `inventory-adoption.spec.ts` in both directions). A tenant with no such
transactions may still choose freely, which is initial configuration rather than a
change made too late.

The workspace configuration screen is **read-only**: it offers no control that
could change a mode, asserted by enumerating interactive roles rather than
spot-checking one button.

### Workspace login

Resolution order is workspace slug → `x-tenant-id` → unique email. A slug narrows
the search and never widens it: the Tile Shop owner's credentials with the
Restaurant slug return 401 (`WS-104`), and an unknown slug returns 401 without
naming any workspace that exists (`WS-105`).

### Authentication and throttling

Unchanged from Slice 7 and re-run here: login, PIN login and refresh are
rate-limited on source IP and a tenant-scoped identity, returning a generic 429
with `Retry-After`. The store is **process-local** — a single replica only, logged
as a warning at boot. Phase 1 makes no multi-replica claim.

## Development workspaces

Seeded by `pnpm db:seed`. Idempotent — running it twice changes nothing, verified.

### Tile Shop (unchanged)

| | |
|---|---|
| Workspace | `demo` |
| Owner | `owner@hardwarepos.test` / `password123` |
| Accountant | `accountant@hardwarepos.test` / `password123` |
| Manager PIN | `2222` |
| Cashier PIN | `1111` |
| Profile | **no profile row** — resolves to the legacy `TILE_SHOP` / QuickBooks configuration |

`tnt_dev` is deliberately left without a `TenantBusinessProfile`, so a developer's
default database exercises the legacy-default path every existing production tenant
is on.

### Restaurant

| | |
|---|---|
| Workspace | `resto-demo` |
| Owner | `owner@axlorestaurant.test` / `password123` |
| Cashier PIN | `3333` |
| Profile | `RESTAURANT` · `LOCAL` inventory · `NONE` accounting (explicit) |

> **These differ from the values named in the Slice 9 brief** (`restaurant-demo`,
> `restaurant.owner@axlopos.test`, `Restaurant123!`). The table above is what the
> approved Slice 8 seed actually creates and what was verified end to end. The
> credentials were not changed to match the brief — renaming a seeded workspace
> silently would leave the two records disagreeing about which is real. Say the
> word and the seed will be updated to the briefed values in a follow-up.

### What the Restaurant account can do

Verified in `workspaces.spec.ts`:

- Sign in with workspace, email and password; the workspace is remembered per device.
- Load its effective profile and receive Restaurant navigation.
- Manage its local catalogue — create products with no `quickbooksItemId` and no
  sync job.
- Reach shared Customers, Sales, Reports, Users, Branches and Settings subject to
  permissions.
- Remain isolated from the Tile Shop tenant.

It does **not** see Retail POS, Quotations, Exchanges, Suppliers, QuickBooks, or
any Tile Shop data — each asserted negatively *and* against the Tile Shop as a
positive control.

### Restaurant routes

| Route | State |
|---|---|
| `/dashboard` | working (shared) |
| `/products` | working (shared, local catalogue) |
| `/customers` | working (shared) |
| `/sales` | working (shared core — completed-sale history) |
| `/settings`, `/settings/business` | working (shared; business page read-only) |
| `/tables` | **shell** — marked "Soon", states it is not implemented |
| `/takeaway` | **shell** — same |
| `/kitchen` | **shell** — same |
| `/menu` | **shell** — same |

Refused for this tenant, by both the client gate and the server: `/pos`,
`/quotations`, `/returns`, `/suppliers`, `/quickbooks`.

**Restaurant ordering is not implemented.** No table session, no order, no order
round, no kitchen ticket, no restaurant bill. The four shells exist so navigation
and module gating could be built and tested against a real workspace; each says on
screen that the feature is not implemented, and none contains fake data or a
control that appears to work.

## Running it locally

```bash
pnpm install
docker compose up -d                    # PostgreSQL 16 on :5432
cp apps/api/.env.example apps/api/.env  # set a real JWT_SECRET
cp packages/database/.env.example packages/database/.env
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev                                # web :3000, API :4000
```

Sign in at http://localhost:3000/login with either workspace above. Leave the
workspace field blank if the email is unique across tenants; it is required only
when an address exists in several.

**PIN sign-in needs the device commissioned first.** Sign in once with an email and
password in that browser; the PIN box then works for that tenant, and keeps working
across sign-out. This replaced a hard-coded development tenant, so an existing
terminal needs one email sign-in after upgrading.

Two traps worth knowing:

- `pnpm build` overwrites `apps/web/.next`, which a running `pnpm dev` server is
  using. The dev server does not recover on its own — restart it after a build.
- `pnpm test` includes Playwright, so it needs a stack already running and fails on
  a machine without one. Run the unit suites directly
  (`pnpm --filter @hardware-pos/web test`) when that is not what you want.

To point the browser suite at a non-default stack:

```bash
E2E_BASE_URL=http://localhost:3100 E2E_API_URL=http://localhost:4100/v1 \
  pnpm exec turbo run test --concurrency=1
```

`--concurrency=1` matters: running the browser suite alongside the unit suites
loads the same API and destabilises the API tests.

## Known limitations

1. **No restaurant operational capability.** Menu, tables, takeaway and kitchen are
   shells. Ordering, kitchen routing and restaurant billing begin at Phase 3.
2. **`QB-006/007/008` is flaky.** It failed on the suite's 15 s per-action timeout
   in 2 of 7 runs and passed in the other 5, including the final `pnpm test`. The
   case performs a full QuickBooks sync against the **live Intuit sandbox**, so its
   duration depends on a third party: measured directly it returns 201 in ~6.2 s,
   and it has been seen taking over 15 s. The development database has accumulated
   **1,729** products across past e2e runs, which does not help. This is a timing
   sensitivity against an external service, not a functional failure, and nothing
   in Slice 8 touches the sync path. Fix belongs with the e2e suite: give the bulk
   sync its own generous timeout rather than the default action timeout, and run
   the suite against a reset database.
3. **Module gating is deferred on the retail write path** — sale draft/complete,
   payments, receipts, print jobs, discounts — and on the mixed
   `DocumentsController`. Classified in the matrix, guard not yet applied.
4. **Rate limiting is process-local.** Several replicas each keep their own
   counters. A distributed store or an edge limiter is required before running more
   than one replica (Phase 14).
5. **Frontend module gating is usability only.** It is client-side and can be
   bypassed; the server is the authority and refuses regardless.
6. **Staging does not exist** (decision D4). This blocks production deployment
   absolutely, and has since Phase 1 began.
7. **Two lint warnings** in `apps/api/src/common/testkit/` — unused
   `eslint-disable` directives, pre-existing, unchanged by this work, and `pnpm
   lint` exits 0.
8. **Development credentials differ from the Slice 9 brief** — see the note above.

## Acceptance recommendation

**Accept Phase 1**, with limitations 2, 3 and 6 recorded as follow-up work. Every
required command passes; nothing below is a failing check.

The exit gate was *"Tile Shop provably unchanged; a Restaurant tenant creates zero
`SyncJob` rows"*. Both hold: the Tile Shop's navigation, product screens,
QuickBooks behaviour and characterisation tests are unedited and green, and a LOCAL
tenant's catalogue writes queue no sync job (asserted in `catalog-adoption.spec.ts`
and over HTTP in `WS-803`).

Limitation 6 blocks *production deployment*, not acceptance of the phase. Nothing
here should be deployed to production until staging exists.

## Proposed scope — Restaurant Phase 2

Offered for approval. **Not started, and not to be started without it.**

1. **DB-backed permissions.** Move role → permission mapping out of the shared
   constant into `Role` / `Permission` tables, per tenant, with the current mapping
   as the seeded default. Parity test against the shared constant before it is
   retired.
2. **Restaurant roles** — Waiter, Chef, and a restaurant Cashier — as data, with
   the permissions they need for the Phase 3-5 workflows.
3. **Branch scoping.** `branchId` in the JWT and a `BranchScopeGuard`, so a user
   assigned to one branch cannot read another's sales, customers or stock. This is
   a real gap today.
4. **Audit expansion** to cover profile and module changes, role changes, and
   branch-scope denials.
5. **Settings cache fix.** `SettingsService` is synchronous and caches per process;
   convert to async and make invalidation correct across replicas, or document the
   single-replica constraint as enforced.
6. **Complete the module gating** deferred in limitation 3 — the retail write path
   and `DocumentsController` — now that sale reads are classified shared core.

Explicitly **not** in Phase 2: every restaurant domain model (`DiningArea`,
`RestaurantTable`, `TableSession`, `RestaurantOrder`, `OrderRound`, `Menu`,
`ModifierGroup`, `KitchenTicket`, `TakeawayOrder`), branch-scoped inventory
(Phase 2.5), WebSockets (Phase 4), printing (Phase 6), and every delivery
integration (Phases 10-12).
