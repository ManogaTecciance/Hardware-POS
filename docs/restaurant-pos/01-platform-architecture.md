# Platform architecture — modular AxloPOS

Status: **partly implemented.** `TenantBusinessProfile`, `TenantModule`, the four
enums, the effective-profile service, the platform API, and the module-access guard
shipped in Phase 1 Slice 4 (decision D21). The provider ports, dynamic navigation,
entitlements, and `IntegrationConnection` remain specification.

Implemented in Slice 4:

| Concern | Where |
|---|---|
| Enums + models | `packages/database/prisma/schema.prisma`, migration `20260804121830_add_tenant_platform_profile` |
| Legacy defaults, default module sets | `apps/api/src/modules/platform/platform.constants.ts` — **the only place fallback logic lives** |
| Effective-profile resolution | `apps/api/src/modules/platform/business-profile.service.ts` |
| Data access (the only cache seam) | `apps/api/src/modules/platform/business-profile.repository.ts` |
| API | `apps/api/src/modules/platform/platform.controller.ts` |
| Gating | `apps/api/src/common/decorators/require-module.decorator.ts`, `apps/api/src/common/guards/module-access.guard.ts` |
| Permissions | `Permission.PLATFORM_PROFILE_READ` / `PLATFORM_PROFILE_MANAGE` |
| Typed web client (unused until Slice 8) | `apps/web/src/lib/platform-api.ts` |

## Layering

```
┌──────────────── PLATFORM LAYER ──────────────────────────────────────────┐
│  TenantBusinessProfile · TenantModule · ModuleRegistry                   │
│  @RequireModule() guard                                                  │
│  Entitlements (deferred — blocked on the commercial model, O5)           │
│  IntegrationConnection (Phase 10)                                        │
└─────────────────────────────────────────────────────────────────────────┘
┌──────────────── SHARED CORE (existing, vertical-neutral) ────────────────┐
│  tenants branches registers auth users roles permissions customers       │
│  products payments discounts taxes settings branding receipts documents  │
│  reports audit notifications storage                                     │
└─────────────────────────────────────────────────────────────────────────┘
┌──────────────── PROVIDER PORTS ─────────────────────────────────────────┐
│  InventoryProvider          LOCAL | QUICKBOOKS | EXTERNAL | DISABLED    │
│  AccountingProvider         NONE  | QUICKBOOKS | FUTURE_EXTERNAL        │
│  PrinterProvider  (Ph. 6)   Mock  | NetworkEscPos | Browser | None      │
│  DeliveryPlatformAdapter (Ph. 10) Mock | UberEats | PickMe | Website    │
└─────────────────────────────────────────────────────────────────────────┘
┌── RETAIL MODULES (existing) ──┐   ┌── RESTAURANT MODULES (Ph. 3-13) ───┐
│ retail-pos quotations returns │   │ menu dining tables sessions orders │
│ exchanges suppliers quickbooks│   │ rounds kitchen kds takeaway        │
│                               │   │ restaurant-billing online-orders   │
└───────────────────────────────┘   └────────────────────────────────────┘
```

## Tenant business profile

One optional row per tenant. **Absence of the row is the backward-compatibility
contract**: an existing tenant with no row behaves exactly as the system does
today. This mirrors the proven `TenantSettings` pattern — stored row optional,
code defaults authoritative in its absence, stored values merged over fresh
defaults so later-added fields appear without a migration.

```ts
export const LEGACY_TENANT_DEFAULTS = {
  businessType:       'TILE_SHOP',
  inventoryMode:      'QUICKBOOKS',
  accountingProvider: 'QUICKBOOKS',
  enabledModules: [
    'RETAIL_POS', 'INVENTORY', 'CUSTOMERS', 'QUOTATIONS', 'RETURNS',
    'EXCHANGES', 'SUPPLIERS', 'REPORTING', 'USERS', 'BRANCHES',
    'SETTINGS', 'BRANDING', 'QUICKBOOKS',
  ],
} as const;
```

### Enums

```prisma
enum BusinessType           { TILE_SHOP HARDWARE RETAIL RESTAURANT CAFE BAKERY GENERAL }
enum InventoryMode          { LOCAL QUICKBOOKS EXTERNAL DISABLED }
enum AccountingProviderKind { NONE QUICKBOOKS FUTURE_EXTERNAL }
```

`AccountingProviderKind` is named with the `Kind` suffix so the persisted enum does
not collide with the `AccountingProvider` TypeScript interface.

### `ModuleKey` — stable persisted identifiers (decision D3)

These values are written to the database. **Do not rename without an approved
data-migration strategy.**

```prisma
enum ModuleKey {
  // Retail + shared
  RETAIL_POS
  INVENTORY
  CUSTOMERS
  QUOTATIONS
  RETURNS
  EXCHANGES
  SUPPLIERS
  REPORTING
  USERS
  BRANCHES
  SETTINGS
  BRANDING
  QUICKBOOKS

  // Restaurant
  MENU_MANAGEMENT
  DINING
  TABLE_MANAGEMENT
  TAKEAWAY
  KITCHEN
  KITCHEN_DISPLAY
  ONLINE_ORDERS
  DELIVERY_INTEGRATIONS
  RESERVATIONS
}
```

`PAYMENTS` is deliberately **not** a module key: payment collection is core to
every business profile and must never be switchable off.

### Default module sets by business type

| `BusinessType` | Default enabled modules |
|---|---|
| `TILE_SHOP`, `HARDWARE`, `RETAIL` | `RETAIL_POS` `INVENTORY` `CUSTOMERS` `QUOTATIONS` `RETURNS` `EXCHANGES` `SUPPLIERS` `REPORTING` `USERS` `BRANCHES` `SETTINGS` `BRANDING` `QUICKBOOKS` |
| `RESTAURANT`, `CAFE`, `BAKERY` | `MENU_MANAGEMENT` `DINING` `TABLE_MANAGEMENT` `TAKEAWAY` `KITCHEN` `CUSTOMERS` `REPORTING` `USERS` `BRANCHES` `SETTINGS` `BRANDING` |
| `GENERAL` | `CUSTOMERS` `REPORTING` `USERS` `BRANCHES` `SETTINGS` `BRANDING` |

A Restaurant tenant never receives `EXCHANGES`, `QUOTATIONS`, `RETURNS`,
`SUPPLIERS`, or `QUICKBOOKS` by default (decision D2 for `EXCHANGES`).
`KITCHEN_DISPLAY`, `ONLINE_ORDERS`, `DELIVERY_INTEGRATIONS`, and `RESERVATIONS`
are opt-in, matching the Release 1 / Release 2 boundary.

## Module gating

`@RequireModule(ModuleKey.X)` on a controller or handler, enforced by
`ModuleAccessGuard`, registered globally **after** `PermissionsGuard`:

```
JwtAuthGuard → RolesGuard → PermissionsGuard → ModuleAccessGuard
```

Guard rules:
- No `@RequireModule` metadata → allow (every existing route is unaffected).
- Module enabled → allow.
- Module not enabled → `403 Feature not available`.
- Profile row missing → resolve `LEGACY_TENANT_DEFAULTS`, then apply the above.
- **Fail closed.** Any error resolving the profile denies rather than allows;
  disabling a module is a revocation and must never fail open. Specifically:
  no authenticated tenant → `403`; an unrecognised module key in the metadata →
  `403`; the profile lookup throwing → `403`.
- Every denial returns the **same generic message**, so a response never discloses
  which modules a tenant has.

`@RequireModule` gates *tenant configuration*; `@RequirePermissions` gates *role
authority*. They compose — a route needing both keeps both decorators — and a
module denial is not a substitute for a permission check.

### Where it is applied today

`QuotationsController` only, with `ModuleKey.QUOTATIONS`. That is enough to prove
the mechanism on a live route without inventing controllers for a domain that does
not exist yet. `QUOTATIONS` is in `LEGACY_TENANT_DEFAULTS`, so no existing tenant is
affected; a tenant that explicitly configures a `RESTAURANT` profile receives `403`,
which is the intended outcome.

Applied at class level deliberately: the public share-link routes live in the
separate `PublicQuotationsController`, so nothing `@Public()` is gated by a guard
that would have no authenticated tenant to evaluate against.

The single-controller application is accepted as **architectural proof**, not as a
partial rollout to be finished mechanically — see the classification rules below
(decision D22).

## Route classification (decision D22)

**`@RequireModule` is not applied blindly to every controller.** A module flag is a
commercial/vertical switch, not an access-control mechanism, and putting one on a
shared route would make core POS behaviour depend on a tenant's product tier.

### Rules

1. **Shared AxloPOS core routes are governed by authentication, tenant isolation,
   and permissions — never by an optional business-module flag.** Auth, users,
   branches, settings, branding, customers, payments, reports, audit, storage,
   health, and documents are core to every business profile.
2. **Business-specific workflow routes must require the relevant `ModuleKey`.**
3. **A controller holding both shared and business-specific operations must be
   mapped at route level, or split, before any controller-level guard is applied.**
   A class-level decorator on a mixed controller silently gates the shared half.
4. **Every future Restaurant-specific controller must fail closed and declare its
   required module explicitly.** `@RequireModule` is part of writing the
   controller, not a follow-up task.
5. **No new Restaurant route may exist without backend module enforcement.** Hidden
   navigation is not enforcement.
6. **A complete route-to-module matrix must be produced and approved before the
   first real Restaurant tenant is onboarded.**
7. The comprehensive rollout does not happen during Slice 5.

### The matrix, when it is produced

It must classify **every controller and every route** in the repository by reading
its actual business responsibility — not by guessing from the controller name — into
exactly one of:

```
SHARED_CORE
RETAIL_POS   INVENTORY   CUSTOMERS   QUOTATIONS   RETURNS   EXCHANGES
SUPPLIERS    REPORTING   USERS       BRANCHES     SETTINGS  BRANDING   QUICKBOOKS
MENU_MANAGEMENT   DINING   TABLE_MANAGEMENT   TAKEAWAY   KITCHEN
KITCHEN_DISPLAY   ONLINE_ORDERS   DELIVERY_INTEGRATIONS   RESERVATIONS
```

`SHARED_CORE` is a classification outcome, not a `ModuleKey` — a `SHARED_CORE` route
carries no `@RequireModule` at all. `PAYMENTS` is absent from the list for the same
reason it is absent from `ModuleKey`: taking payment is core to every profile.

Known rule-3 cases, from reading the controllers during Slice 4 (route lists as of
this commit, not guesses from the class names):

| Controller | Shared routes | Business-specific routes |
|---|---|---|
| `DocumentsController` | `GET sales/:saleId`, `GET returns/:returnId` | `POST preview/:type` and `GET sample-pdf/:type` accept `type=exchange`, so `EXCHANGES` gating is a **route-and-parameter** concern, not a controller one |
| `SyncController` | `GET status`, `GET logs` — operational visibility | `POST sales/:id/retry`, `POST products/refresh` — QuickBooks-specific |
| `ProductsController` | 13 catalogue routes under `PRODUCT_READ`/`PRODUCT_MANAGE` | `POST sync/mock`, `POST :id/sync-to-quickbooks` under `QUICKBOOKS_MANAGE` |
| `DashboardController` | All 7 routes under `SALE_READ`. Likely `SHARED_CORE`/`REPORTING`, since a restaurant table session also produces a `Sale` | but `top-categories` and `top-products` assume a product catalogue, so the matrix must decide per route rather than per controller |

`QuotationsController` is the counter-example that made it a safe proof: every route
is `QUOTATION_*`, and the one `@Public()` route already lives in a separate class.

### Precedence of module resolution

1. An explicit `TenantModule` row wins, **in both directions** — `isEnabled: false`
   is a revocation and is never overridden by the business-type default. Without
   this, turning a module off would be impossible.
2. Otherwise the default set for the tenant's `businessType` applies, so a tenant
   created before a new module shipped picks it up without a data migration.
3. With no profile row at all, `LEGACY_TENANT_DEFAULTS` applies.

`PATCH /platform/profile` with `enabledModules` records unlisted modules as
explicitly disabled rather than deleting their rows, so "off" survives as a stated
fact instead of decaying into "no opinion".

## Platform API

| Route | Permission | Purpose |
|---|---|---|
| `GET /v1/platform/profile` | `PLATFORM_PROFILE_READ` | The effective profile, with `source: EXPLICIT \| LEGACY_DEFAULT` |
| `GET /v1/platform/modules` | `PLATFORM_PROFILE_READ` | Per-module state, distinguishing "disabled" from "never configured" |
| `PATCH /v1/platform/profile` | `PLATFORM_PROFILE_MANAGE` | Create or update the authenticated tenant's explicit profile |

Contract rules:

- The tenant comes from `@TenantId()` — the verified session. **No route accepts a
  tenant id as a parameter, query string, or body field.** `UpdateBusinessProfileDto`
  has no `tenantId` property, and the global `ValidationPipe` runs with
  `forbidNonWhitelisted`, so a client that sends one gets a `400` rather than having
  it silently ignored.
- This is not global super-admin functionality: there is no cross-tenant listing and
  no tenant-selection parameter anywhere.
- Every field on `PATCH` is optional. Omitting `enabledModules` leaves module
  configuration untouched; sending it replaces the configuration wholesale.
- Enum and module values are validated before any database work starts. Unknown
  module keys and duplicated keys are `400`.
- The profile row and the module rows are written in **one transaction**, so a
  rejected key can never leave a tenant with a new business type and a stale module
  set.
- `version` increments on every write — an optimistic-concurrency token. It is
  `null` for a `LEGACY_DEFAULT` response, because there is no row to version.
- A successful `PATCH` records a `platform_profile.updated` audit entry. A rejected
  one records nothing.

### Permissions

| Role | Read | Update |
|---|---|---|
| `OWNER` | ✅ | ✅ |
| `ADMIN` | ✅ | ✅ |
| `MANAGER` | ✅ | ❌ |
| `ACCOUNTANT` | ✅ | ❌ |
| `CASHIER` | ✅ | ❌ |

Read is granted to every authenticated role deliberately and by Product Owner
decision (D23): navigation and capability decisions are driven by the tenant's
enabled modules, so a cashier that could not read them could not render a POS
screen.

### What the effective profile may and may not contain (decision D23)

`GET /v1/platform/profile` is a **user-safe** response. It may carry:

`businessType` · `inventoryMode` · `accountingProvider` · `enabledModules` ·
`source` (the profile source) · `version` · safe presentation metadata where
required.

It must **never** carry:

- QuickBooks access tokens or refresh tokens
- delivery-platform credentials
- API secrets
- encrypted credential values of any kind
- internal infrastructure configuration
- any other tenant's data

The response shape is asserted key-by-key in `platform-profile.spec.ts`, and the
serialised body is matched against `/quickbooks[A-Za-z]*Id/i` and `/realmId/i` so a
future field cannot quietly introduce a leak. Anyone adding a field here must keep
that test honest — the guard is the test, not the review.

`PATCH` stays restricted to OWNER and ADMIN. CASHIER, MANAGER, and ACCOUNTANT must
not update the profile.

Enforcement is on the **backend**. Hiding navigation is a usability measure, not a
security control.

## Caching and multiple replicas (decision D11)

**The business profile and module set are authorization inputs and are NOT cached
across requests.**

A stale cache on a revocation (module disabled, accounting provider switched) is
fail-open for the whole TTL, on every replica. That is unacceptable regardless of
TTL length. Instead:

- one indexed read per request on the guard path — `TenantBusinessProfile` by
  `tenantId` (`UNIQUE`) and `TenantModule` by `tenantId` (indexed);
- memoised for the lifetime of a **single request only**, so a request that hits
  the guard and then a service does not query twice. Request-scoped memoisation
  is not shared state and cannot go stale;
- `BusinessProfileRepository` is the single seam where a cross-request cache
  would ever be introduced, and only once profiling justifies it.

### Existing `SettingsService` — known residual risk

`SettingsService.getSettings(tenantId)` is **synchronous**, with roughly 20 inline
call sites across sales, returns, quotations, receipts, and documents. It is served
from a process-local `Map` hydrated at boot.

This matters because `taxRatePercent` lives there: a stale settings cache on a
second replica computes **wrong tax** — a money bug, not a cosmetic one.

- **Phase 1 mitigation** (a mitigation, not a fix): `SETTINGS_CACHE_TTL_MS`,
  default 15 000. Bounds staleness to ~15 s instead of "until the process
  restarts". Scheduled in Slice 7.
- **Phase 2 fix**, one of: (a) convert to async — mechanical, wide, fully correct,
  preferred; (b) PostgreSQL `LISTEN`/`NOTIFY` via a small raw `pg` client — near
  instant, no Redis; (c) Redis pub/sub — new infrastructure, but needed anyway if
  Socket.IO scales across replicas (see O2).

### Current deployment reality

`docker-compose.prod.yml` runs exactly one `api` service, and its
`container_name: hardware-pos-api` actually prevents `docker compose up --scale`.
So there is one replica today and no live staleness bug. D11 is nonetheless the
correct posture and all new code honours it. Scaling out will additionally require
removing `container_name` and placing a load balancer in front of Caddy, which
currently proxies to a single `api:4000`.

## Navigation

One item table, three filters — permission, module, business type. The retail and
restaurant sidebars are the **same array filtered differently**; there is no second
hardcoded sidebar.

```ts
buildNav(profile, permissions) // → NavGroup[]
```

An item is shown when its permission (if any) is satisfied **and** its module (if
any) is enabled. A legacy tenant with no profile row must yield today's exact ten
items in today's exact order — asserted by `nav.test.ts`.
