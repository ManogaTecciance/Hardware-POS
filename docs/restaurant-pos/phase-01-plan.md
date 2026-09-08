# Phase 1 — platform modularisation and optional QuickBooks

Branch: `feature/restaurant-pos`. Base: `523d6af`.

**Slices 0-3 implemented. Slices 4-8 await approval** (decision D18).

## Goal

Make QuickBooks optional and the platform modular, **without changing a single
behaviour for existing Tile Shop tenants** and without removing any QuickBooks
column, module, or workflow.

## Slices

| # | Slice | Status | Behaviour risk |
|---|---|---|---|
| 0 | Deployment & repository safety | ✅ | none |
| 1 | Documentation reorganisation | ✅ | none |
| 2 | Integration-test harness | ✅ | none |
| 3 | Characterisation tests for existing behaviour | ✅ | none (tests only) |
| 4 | Platform data model — profile, modules, migration, guard | ⏸ | low (additive) |
| 5 | Provider ports — interfaces + implementations, **inert** | ⏸ | none (no call sites) |
| 6 | Provider adoption — rewire sales, returns, products | ⏸ | **the only risky slice** |
| 7 | Security & consistency fixes | ⏸ | low |
| 8 | Frontend modularisation | ⏸ | low |

### Slice 0 — deployment & repository safety *(implemented)*

- `apps/api/docker-entrypoint.sh` — new entrypoint with `serve` (default) and
  `migrate` commands. `RUN_MIGRATIONS_ON_BOOT` defaults to `false`; production
  migrations are a separate approved step (decision D15). Runbook in
  [`06-migration-and-rollout.md`](./06-migration-and-rollout.md).
- `apps/api/Dockerfile` — `ENTRYPOINT` + `CMD ["serve"]`, `ENV
  RUN_MIGRATIONS_ON_BOOT=false`; the old auto-migrating `CMD` is gone.
- `docker-compose.prod.yml` — corrected the comment that claimed migrations run
  automatically on boot.
- `.env.example`, `.env.prod.example` — document the flag and the explicit command.
- `package-lock.json` — removed and gitignored (decision D14, verification recorded
  in [`00-decisions.md`](./00-decisions.md)).
- `README.md` — corrected the materially false status line (decision D12).

### Slice 1 — documentation *(implemented)*

`docs/restaurant-pos/` created with 11 documents.
`docs/restaurant-backend-plan.md` retains all original content and gains a
superseded notice that records what was superseded and what was deliberately kept
(decision D1).

### Slice 2 — integration-test harness *(implemented)*

See [Integration-test architecture](#integration-test-architecture) below.

### Slice 3 — characterisation tests *(implemented)*

Specs authored against **unmodified** production code and proven green there, so
they are a baseline rather than a description of a refactor. They pin the exact
current behaviour that Slice 6 must preserve.

### Slice 4 — platform data model ✅ *(implemented)*

`TenantBusinessProfile`, `TenantModule`, and the four enums specified in
[`01-platform-architecture.md`](./01-platform-architecture.md). One additive
migration (`20260804121830_add_tenant_platform_profile`), no backfill. A
`platform` module with three endpoints (`GET`/`PATCH /v1/platform/profile`,
`GET /v1/platform/modules`), `@RequireModule()` + `ModuleAccessGuard` registered
globally after `PermissionsGuard`, and two permissions. No cross-request cache on
the authorization path (decision D11).

The migration was proven additive and reversible against **disposable** databases:
a baseline database carrying only the 19 prior migrations was diffed against a
fully migrated one (0 pre-existing objects changed, 59 added, all belonging to the
two new tables and four new enums), then the rollback SQL in
`packages/database/prisma/rollbacks/` was applied and the schema compared byte for
byte against that baseline.

`@RequireModule` is applied to exactly one live controller — `QuotationsController`
— which is enough to prove the mechanism without inventing restaurant routes.

Frontend scope was limited to the typed client `apps/web/src/lib/platform-api.ts`,
which nothing imports yet. Tile Shop navigation is untouched; dynamic navigation is
Slice 8.

### Slice 5 — provider ports *(awaiting approval)*

`InventoryProvider` and `AccountingProvider` per
[`02-provider-abstractions.md`](./02-provider-abstractions.md), with
`Local`/`QuickBooks`/`No` inventory and `No`/`QuickBooks` accounting
implementations plus factories. **Transaction-aware signatures.** Ports land with
zero call-site changes so Slice 6 is a small, reviewable diff.

### Slice 6 — provider adoption *(awaiting approval)*

Rewire `sales.service.ts`, `sales.repository.ts`, `returns.repository.ts`,
`products.service.ts`. Pure extraction — Slice 3's tests must stay green
**unedited**.

### Slice 7 — security & consistency *(awaiting approval)*

Tenant-scope `findActiveByEmail`; throttle login and PIN login; consolidate
permissions into `packages/shared`; align the shared `UserRole` additively with a
parity test (decision D13); add `SETTINGS_CACHE_TTL_MS` as the interim
multi-replica mitigation.

### Slice 8 — frontend modularisation *(awaiting approval)*

Business-profile context; `buildNav(profile, permissions)`; gate QuickBooks
navigation and routes on `accountingProvider === QUICKBOOKS`; read-only
`settings/business` page; remove the hardcoded `DEV_TENANT`; extend
`provision-tenant.ts` and add a Restaurant demo tenant to `seed.ts`.

## Explicitly excluded from Phase 1

`SubscriptionPlan` / `PlanFeature` / entitlements (blocked on the commercial
model, O5) · `IntegrationConnection` (Phase 10) · DB-backed permission enforcement
and restaurant roles (Phase 2) · `branchId` in the JWT and `BranchScopeGuard`
(Phase 2) · `BranchInventory` / `StockMovement` (Phase 2.5) · every restaurant
domain model · `PrinterProvider`, ESC/POS, any `PrintJob` change (Phase 6) ·
WebSockets / Socket.IO (Phase 4) · service-charge and restaurant tax configuration
(Phase 8) · delivery adapters and webhook infrastructure (Phase 10) ·
token-storage redesign and global rate limiting (Phase 14) · async
`SettingsService` conversion (Phase 2) · removing or renaming **any** QuickBooks
column (never) · any Exchange transaction workflow (decision D2).

## Integration-test architecture

**docker-compose-first, with a Testcontainers path left open.** The repository
already has a compose-based developer workflow and no Docker-in-Node dependency;
Testcontainers would add a heavy dependency and require a reachable Docker socket
everywhere. Compose keeps the local workflow understandable (decision D5). Specs
never reference the transport, so a Testcontainers driver can be added later without
touching one of them.

```
docker-compose.test.yml            PostgreSQL 16, port 5433, hardware_pos_test, tmpfs
apps/api/test/integration/
  jest.integration.config.ts       separate Jest project, runInBand
  global-setup.ts                  assert → migrate deploy
  assert-test-database.ts          the safety guard
  assert-test-database.spec.ts     the guard's own unit spec
  db-reset.ts                      information_schema-driven TRUNCATE
  prisma-test-client.ts            single shared PrismaClient
  fixtures.ts                      three tenants (see below)
  specs/…
```

### Production-URL protection (decision D5)

`assertTestDatabase()` runs in `globalSetup` and throws **before any connection is
opened** unless every condition holds:

1. `NODE_ENV === 'test'`
2. `DATABASE_URL` present and parseable as `postgresql://`
3. database name matches `/_test$/` — `hardware_pos_test` ✅, `hardware_pos` ❌
4. host ∈ `{localhost, 127.0.0.1, ::1, host.docker.internal, postgres-test, db-test}`
5. host/URL matches **no** denylist entry: `amazonaws.com`, `rds.`, `neon.tech`,
   `supabase.`, `axlopos.com`, `prod`, `production`, `live`
6. port ≠ 5432 unless the host is a compose service name — defence against a
   mistyped dev URL
7. shape heuristic at runtime: the database is either empty or, if `Sale` exists,
   holds fewer than 1000 rows — a scratch database, never a real one

The guard has its **own unit spec** asserting that realistic production URLs are
rejected. Four independent barriers protect production: this guard, the `_test`
name requirement, the non-default port, and an ephemeral `tmpfs` volume.

### Isolation, repeatability, cleanup

- Schema applied with `prisma migrate deploy` — never `migrate dev` — so tests
  validate the exact SQL production will receive.
- `resetDatabase()` discovers tables from `information_schema` (so it never drifts
  as models are added), excludes `_prisma_migrations`, and issues a single
  `TRUNCATE … RESTART IDENTITY CASCADE`. Called in `beforeEach`.
- Fixtures are deliberately independent of `prisma/seed.ts`, which is demo data and
  will drift:
  - `tenantTileShopQb` — the QuickBooks retail baseline
  - `tenantRestaurantLocal` — the future restaurant subject
  - `tenantLegacyNoProfile` — **no profile row**, the backward-compatibility subject
- Deterministic ids from a seeded counter; no wall-clock values in fixture data; no
  cross-spec ordering dependency; `maxWorkers: 1` initially — correctness before
  speed.
- Registered as a **separate** turbo task, **not** part of `pnpm test`, so the
  default suite stays fast and requires no Docker.

## Existing-data compatibility

The core invariant: **absence of a `TenantBusinessProfile` row must be
indistinguishable from today.** `LEGACY_TENANT_DEFAULTS` resolves
`TILE_SHOP` / `QUICKBOOKS` / `QUICKBOOKS` plus all thirteen retail modules —
exactly the fallback-to-defaults trick `SettingsService` already proves in
production.

QuickBooks provider bodies will be the **moved** existing code, reviewable as a pure
extraction diff, so `resolveDocumentType` returns today's
`paidAmount >= total ? SALES_RECEIPT : INVOICE` and re-raises the identical
"customer required" message.

## Regression strategy

Four layers, detailed in [`05-testing-strategy.md`](./05-testing-strategy.md):
characterisation (proven on unmodified code first) · existing unit suites unmodified
· integration snapshots against real PostgreSQL · Playwright unmodified.

**Hard rule:** if a Phase 1 change requires editing an existing behavioural test,
the change is not backward-compatible and must be redesigned (decision D16).

## Restaurant-without-QuickBooks acceptance test

The headline Phase 1 acceptance test, for a tenant with
`businessType=RESTAURANT`, `inventoryMode=LOCAL`, `accountingProvider=NONE`:

| # | Assertion |
|---|---|
| R1 | sale completes; `status = COMPLETED` |
| R2 | `SyncJob` count for the tenant = **0** |
| R3 | `SyncLog` count for the tenant = **0** |
| R4 | `Sale.quickbooksDocumentType` **IS NULL** |
| R5 | `Sale.quickbooksDocumentId` **IS NULL** |
| R6 | `Sale.syncStatus = NOT_SYNCED` — never `PENDING`, never a fabricated `SYNCED` |
| R7 | `Payment.quickbooksPaymentId` **IS NULL**; `syncStatus = NOT_SYNCED` |
| R8 | `Product.quantityOnHand` decremented by exactly the sold quantity |
| R9 | overselling still rejected — the `gte` guard survives the `LOCAL` provider |
| R10 | a credit sale **without** a customer succeeds — the QuickBooks Invoice constraint must not apply when there is no accounting provider |
| R11 | return completes; stock restored; **zero** `SyncJob` rows |
| R12 | `GET /v1/quickbooks/status` returns 403 or a clean "not applicable", never a 500 |
| R13 | `/quickbooks/*` web routes redirect away |
| R14 | sidebar excludes QuickBooks, Quotations, Returns, Suppliers, Exchanges |
| R15 | `inventoryMode=DISABLED` → stock unchanged, no oversell rejection, sale still completes |
| R16 | the sync worker, running concurrently, finds nothing to do for this tenant |

R10 is the subtle one. `sales.service.ts` currently throws when a credit sale has no
customer, purely because a QuickBooks Invoice requires a `CustomerRef`. Under
`NoAccountingProvider` that constraint is meaningless — a restaurant running a tab
for an unnamed walk-in must not be blocked by a QuickBooks rule. R10 proves the
refactor achieved its purpose.

## Acceptance criteria

Build and existing tests: `lint`/`typecheck`/`test`/`test:integration`/`build`
green; all 47 API and 26 web unit tests pass **unmodified**; all 113 Playwright
cases pass **with zero edits to any existing spec**.

Backward compatibility: a tenant with no profile row produces byte-identical
database side effects to `main`; every Slice 3 characterisation test passes both
before and after Slice 6, unedited; `SyncJob`/`SyncLog` row shape unchanged for a
QuickBooks tenant; the Exchange A4 document renders identically; a legacy tenant's
sidebar shows today's exact ten items in today's exact order.

Restaurant without QuickBooks: all sixteen R-assertions pass.

Architecture: no QuickBooks business logic remains in `modules/sales` or
`modules/returns` outside a provider call; `Permission` and `ROLE_PERMISSIONS` exist
in exactly one file; shared and Prisma `UserRole` are provably at parity; no
provider mutator lacks a `Prisma.TransactionClient` parameter and the atomicity
rollback test passes; `BusinessProfileService` holds no cross-request cache.

Security: two tenants sharing an email each authenticate into their own tenant,
100/100; failed logins throttled; `PATCH /v1/platform/profile` 403s for
`CASHIER`/`MANAGER`/`ACCOUNTANT`; Tenant A cannot read or write Tenant B's profile;
the production-URL guard spec passes.

Migration: no `DROP`, no `UPDATE`, no `ALTER` against any pre-existing table;
rollback verified on the disposable database; `RUN_MIGRATIONS_ON_BOOT` defaults to
`false` and the runbook documents the explicit command.

Documentation: `docs/restaurant-pos/` complete; the superseded notice in place with
original content intact; README factually correct; `testcases.md` carries `PLAT-*`
rows and honest `EXC-*` `Blocked` rows.
