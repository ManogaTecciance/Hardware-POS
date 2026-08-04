# Phase 0 — repository audit

Audited at `523d6af` on 2026-08-04. Source code, schema, migrations, and tests were
treated as the primary source of truth; documentation was not trusted.

## Executive summary

The codebase is materially more complete than its README claimed: 25 controllers,
136 routes, 205 TypeScript files in the API, 30 Prisma models, 19 sequential
migrations, a live QuickBooks OAuth + sync integration with a transactional outbox,
server-authoritative money maths, and 113 Playwright cases mapped 1:1 to a 365-row
`testcases.md`.

Three structural properties make the restaurant pivot feasible rather than a
rewrite:

1. **Local inventory already works.** `sales.repository.ts` decrements
   `Product.quantityOnHand` inside the sale transaction with a conditional
   `updateMany({ where: { quantityOnHand: { gte: qty } } })` guard; returns
   re-increment eagerly. QuickBooks is a *downstream* side effect via the outbox,
   not the stock authority in the write path. `InventoryMode=LOCAL` is largely
   built.
2. **QuickBooks already sits behind a queue seam.** Sale completion calls
   `syncQueue.enqueueSaleSync(tx, …)`; a polling worker dispatches to per-type
   handlers. Swapping the handler set per tenant is contained.
3. **`TenantSettings` is the right template for business profiles** — a JSON blob,
   cached, merged over code defaults, with **absent rows falling back to
   defaults**. Copying that shape gives a Phase 1 migration with zero backfill and
   zero risk to existing tenants.

## Architecture

pnpm 10.33 workspaces + Turborepo 2.3, Node ≥20, TypeScript 5.6 strict.

| Package | Stack | Scale |
|---|---|---|
| `apps/api` | NestJS 11, Express, Prisma | 205 `.ts`, 25 controllers, 136 routes |
| `apps/web` | Next.js 15 App Router, React 19, Tailwind 4 | 38 pages/layouts |
| `apps/e2e` | Playwright 1.49 | 18 specs, 113 cases |
| `packages/database` | Prisma 6, PostgreSQL 16 | 1161-line schema, 19 migrations |
| `packages/shared` | pure TypeScript | 8 files |

Global API pipeline: prefix `/v1`, `ValidationPipe` (`whitelist`,
`forbidNonWhitelisted`), then
`JwtAuthGuard → RolesGuard → PermissionsGuard`, `TransformInterceptor` (`{ data }`
envelope), `AllExceptionsFilter`.

House module pattern, consistently followed:
`controller → service → repository → PrismaService`, class-validator DTOs,
`@TenantId()` / `@CurrentUser()`, `Paginated<T>`, pure `*.calc.ts` with colocated
specs. `quotations` and `returns` are the reference implementations.

Deployment: single EC2 instance, `docker-compose.prod.yml` (Caddy → api → db),
Amplify for the web app. Secrets hygiene clean — only `*.env.example` files tracked.

## Implemented modules

auth · users · branches *(read-only list)* · categories/subcategories · products ·
customers · suppliers · sales · payments · returns · quotations · discounts ·
receipts/print-jobs · documents *(Puppeteer A4)* · quickbooks · sync · settings ·
audit-log · dashboard · sharing · health · storage.

## Partially implemented

| Area | Gap |
|---|---|
| RBAC | `Role`/`Permission` tables exist but **no guard reads them**; a static code map is authoritative |
| Branches | list endpoint only; **no branch authorization anywhere** |
| Registers | Prisma model only — no module, no CRUD, no shift/cash-drawer concept |
| Reports | no reports module; two per-domain report services plus the dashboard |
| Tax | one flat tenant rate; `SaleItem.taxAmount` is **always written 0** |
| Branch settings | schema supports `branchId` overrides; service only reads `branchId: null` |
| Audit | applied to quotations, categories, settings, documents, sharing, `return.completed` — **not** to sales, payments, discount approvals, or logins |
| Exchanges | **A4 document renderer only** — no model, migration, module, route, permission, or E2E spec |

## Missing

Platform: business profile, feature flags, module registry, subscriptions,
entitlements, notifications.

Restaurant: everything — dining areas, tables, sessions, orders, rounds, menus,
modifiers, channel pricing, kitchen stations, KOT, KDS, takeaway, service charge,
split billing, reservations, ingredient inventory.

Infrastructure: **network/ESC-POS printing** (browser-only today), printer
registry, station routing, print retry/failover, **real-time transport** (no
WebSocket/SSE), **webhook infrastructure** (none at all — no inbound surface, no
signature verification, no replay protection, no raw-event store), rate limiting,
offline queue.

## QuickBooks dependency map

- **Tier 1 — dedicated modules:** 14 files in `modules/quickbooks/`, 13 in
  `modules/sync/`. Cleanly separable.
- **Tier 2 — schema columns** across `Product`, `Customer`, `Supplier`, `Sale`,
  `Payment`, `Return`, `RefundPayment`, `ProductCategory`, plus
  `QuickBooksConnection`, `QuickBooksMapping`, `SyncJob`, `SyncLog`. **All retained.**
- **Tier 3 — leaks into shared logic** (what Phase 1 removes):
  `sales.service.ts` decides `SALES_RECEIPT | INVOICE` and enforces
  "customer required for a credit sale"; `sales.repository.ts` and
  `returns.repository.ts` call `enqueue*Sync` **unconditionally**;
  `ReturnSettings` carries `quickbooksRefundReceiptDepositAccountRef`.
- **Tier 4 — frontend:** 5 QuickBooks pages, sync badges, a nav item, sync columns
  on five list views.

**How it degrades today:** a tenant with no connection still gets a `SyncJob` per
sale, and `mockSync()` writes a fabricated `QBO-SR-<saleNumber>` into
`Sale.quickbooksDocumentId` and flips `syncStatus` to `SYNCED`. It does not crash —
it quietly pollutes financial records. This is the single most important thing
Phase 1 fixes (and see open question O1 for the disconnected-Tile-Shop case).

## Highest-severity defects found

| Sev | Defect |
|---|---|
| **Critical** | `AuthRepository.findActiveByEmail` is `findFirst({ email, isActive })` with **no tenant scope**, but `User` is only `@@unique([tenantId, email])` — two tenants sharing an email produce non-deterministic cross-tenant login. Latent with one tenant; a live breach on multi-tenant onboarding. |
| **Critical** | The production container ran `prisma migrate deploy` on **every boot** (`Dockerfile` `CMD`), so deploying code *was* migrating the database — with no backup checkpoint, no dry run, and no operator gate. Fixed in Phase 1 Slice 0. |
| High | No rate limiting anywhere; `POST /auth/pin-login` is public and unthrottled |
| High | `findByPin` loads every active PIN user and bcrypt-compares in a loop — O(n) bcrypt per attempt (CPU DoS) and **first match wins**, so shared PINs authenticate as whoever the database returns first |
| High | Access and refresh tokens in `localStorage`; 30-day refresh TTL |
| High | No branch-level authorization |
| Medium | `SettingsService` cache is process-local, so `taxRatePercent` can be stale on a second replica — a money bug |
| Medium | No `StockMovement` ledger; `Product.quantityOnHand` not branch-scoped |
| Medium | `Sale` has no `idempotencyKey` (`Return` does); `Payment` has no concurrency guard |
| Medium | No `version` column on any model |
| Low | `PrintJob.saleId` non-nullable — blocks KOT reuse |
| Low | Hardcoded `DEV_TENANT = 'tnt_dev'` in shipped web auth code |

## Reusable assets

`common/storage/` provider pattern *(the template for the new ports)* ·
`SyncQueueService` + worker + handler registry · `DocumentSequence` ·
`common/money.ts` · the `decrementStock` conditional-update idiom ·
`Return.idempotencyKey` · `QuotationRevision` immutable chain *(the closest
analogue to `OrderRound`)* · `TenantSettings` defaults pattern · `AuditLogService` ·
`DiscountsService` approval flow · documents/receipts templating ·
`common/crypto.ts` · the Playwright harness and `testcases.md` conventions.

## Untouched by Phase 1

All of `modules/quickbooks/` and `modules/sync/` · all 19 existing migrations ·
`documents.service.ts` (including `buildExchangeDocument`) · `receipts/**` ·
`quotations/**` · `common/crypto.ts` · `common/money.ts` ·
`common/document-sequence.ts` · `common/storage/**` · `dashboard/**` · **every
existing test file**.
