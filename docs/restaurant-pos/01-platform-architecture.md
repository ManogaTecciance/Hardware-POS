# Platform architecture — modular AxloPOS

Status: **specification.** `TenantBusinessProfile`, `TenantModule`, and the module
guard land in Phase 1 Slice 4, which is not yet authorised (see
[`00-decisions.md`](./00-decisions.md) D18). Nothing in this document is
implemented yet.

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
- Module not enabled → `403`.
- Profile row missing → resolve `LEGACY_TENANT_DEFAULTS`, then apply the above.
- **Fail closed.** Any error resolving the profile denies rather than allows;
  disabling a module is a revocation and must never fail open.

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
