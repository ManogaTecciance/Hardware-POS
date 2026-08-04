# Restaurant Vertical — Backend Implementation Plan

> ## ⚠️ SUPERSEDED — historical reference only
>
> **This document is no longer the implementation authority.** It was superseded
> on **2026-08-04** by the approved AxloPOS Restaurant POS requirements. The
> canonical documentation now lives in **[`docs/restaurant-pos/`](./restaurant-pos/)**
> — start at [`docs/restaurant-pos/README.md`](./restaurant-pos/README.md).
>
> It is retained deliberately, unmodified below this notice, because it records
> the reasoning behind several decisions that were kept.
>
> **Superseded — do not implement from this document:**
>
> | This document proposed | The approved design instead uses |
> |---|---|
> | `Tenant.vertical` enum (`RETAIL` \| `RESTAURANT`) | `TenantBusinessProfile` with 7 `BusinessType` values |
> | `@RequireVertical()` guard | `@RequireModule()` + `TenantModule` enabled-module flags |
> | `Tab` / `TabRound` / `TabItem` | `TableSession` / `RestaurantOrder` / `OrderRound` / `RestaurantOrderItem` |
> | Multiple concurrent open tabs per table, `label`-distinguished | One `TableSession` per visit, with explicit merge / transfer / unmerge |
> | QuickBooks assumed always present | QuickBooks optional behind `AccountingProvider`; `InventoryMode` selectable |
>
> **Retained and still authoritative (carried into the approved design):**
>
> - Additive-only migrations: new models, new nullable columns, appended enum
>   values. Never widen or repurpose an existing retail column.
> - No `if (vertical)` / `if (businessType)` branching inside shared modules;
>   vertical behaviour lives in vertical modules or behind a provider port.
> - Server-authoritative state — sessions and orders are database entities
>   mutated through the API, never client storage, because several devices work
>   the same table concurrently.
> - Optimistic concurrency via a `version` column plus conditional
>   `updateMany` + row-count checks, following the proven `decrementStock` idiom.
> - **One junction point:** closing a table session produces a `Sale`, so
>   everything downstream (payments, receipts, reports, dashboards, accounting)
>   is reused rather than rebuilt.
> - Follow the house module pattern: `controller → service → repository →
>   PrismaService`, class-validator DTOs, `@TenantId()` / `@RequirePermissions()`,
>   `Paginated<T>` responses, pure `*.calc.ts` with a colocated spec.
> - Menu ≠ catalog: restaurant menu items are their own models, optionally
>   mapped to a `Product`, never forced into the QuickBooks-cached `Product` table.

---

> Status: **superseded** (originally: proposal, not yet implemented) · Scope: `apps/api` + `packages/database` only.
> The retail POS front-end is untouched; a restaurant front-end is a separate effort
> that consumes the APIs specified here.

## 1. Context and goals

The platform today is a retail (hardware-store) POS: catalog cached from QuickBooks,
cart built client-side on one terminal, `POST /sales/complete` writes an immutable
`Sale` and enqueues a QuickBooks push. Restaurants need a different *service* model:

- a **tab per table**, opened at seating and alive for hours;
- items added **incrementally, in rounds**, from multiple devices, at the moment the
  customer asks;
- each fired round produces a **kitchen ticket** on a printer (or screen) in the kitchen;
- the tab eventually **closes into a payment** — at which point it becomes ordinary
  revenue, identical to a retail sale for accounting, reporting, and QuickBooks.

**Hard constraint: zero behavioral change for retail tenants.** Everything here is
additive: new modules, new tables, new enum values, nullable columns. No existing
endpoint changes its contract; no existing service grows vertical conditionals.

**Architecture in one line:** one backend, one database, new `restaurant` domain
modules beside the existing ones, a `vertical` flag on `Tenant` gating access, and a
single junction point — *closing a tab produces a `Sale`* — so everything downstream
of a sale (payments, receipts, reports, dashboards, QuickBooks sync) is reused, not
rebuilt.

## 2. Guiding principles

1. **Additive only.** New Prisma models, new nullable columns, appended enum values.
   Never widen/repurpose retail columns. Every migration must be safe to run against
   a live retail tenant's data.
2. **No `if (vertical)` inside retail modules.** Vertical-specific behavior lives in
   vertical-specific modules. Shared modules (auth, payments, receipts, sync, print
   jobs, settings, storage) stay vertical-neutral.
3. **Follow the house pattern.** Every new module = `controller → service → repository
   → PrismaService`, class-validator DTOs, `@TenantId()` / `@RequirePermissions()`,
   `Paginated<T>` responses, calc logic in a pure `*.calc.ts` with a jest spec
   (the `quotations`/`returns` modules are the template).
4. **Server-side state.** Tabs are database entities mutated through the API — never
   client sessionStorage — because multiple devices work the same tab concurrently.
   All tab mutations run in transactions with row-level guards (same approach as the
   stock decrement in `sales.repository.ts`).
5. **Menu ≠ catalog.** Restaurant menu items are their own models. They may
   *optionally* reference a `Product` for stock depletion, but we do not force
   modifiers and stations into the QuickBooks-cached `Product` table.

## 3. Phase 0 — Platform preparation

Small, prerequisite changes to shared infrastructure. Everything is additive.

### 3.1 Tenant vertical

```prisma
enum BusinessVertical {
  RETAIL
  RESTAURANT
}

model Tenant {
  // …existing fields…
  vertical BusinessVertical @default(RETAIL)
}
```

Migration backfills nothing (default covers existing rows). Retail tenants are
unaffected.

### 3.2 Vertical guard

- `@RequireVertical(BusinessVertical.RESTAURANT)` method/class decorator plus a
  `VerticalGuard` registered globally after `PermissionsGuard` (same pattern).
- Applied to every restaurant controller. A retail tenant calling `/tabs` gets 403;
  nothing else changes. Retail controllers carry no decorator (vertical-neutral or
  retail-implicit).

### 3.3 Roles and permissions

`UserRole` gains two values (additive Postgres enum migration):

```prisma
enum UserRole { CASHIER MANAGER ADMIN OWNER ACCOUNTANT WAITER KITCHEN }
```

New `Permission` entries (append to `apps/api/src/modules/auth/permissions.ts` and
role map — mirrored later in `apps/web/src/lib/permissions.ts` for the front-end):

| Permission | WAITER | KITCHEN | MANAGER+ |
|---|---|---|---|
| `menu:read` | ✓ | ✓ | ✓ |
| `menu:manage` | – | – | ✓ |
| `table:read` | ✓ | – | ✓ |
| `table:manage` (floor plan CRUD) | – | – | ✓ |
| `tab:create` / `tab:read` / `tab:update` | ✓ | – | ✓ |
| `tab:void-item`, `tab:transfer` | – | – | ✓ (managerial) |
| `tab:close` (take payment) | configurable¹ | – | ✓ |
| `kitchen:read` (ticket feed / KDS) | – | ✓ | ✓ |

¹ Whether waiters can settle payments is a per-tenant setting (see 3.4), enforced in
the service, not the permission map.

Existing roles keep their exact current permission sets — the retail role map is not
edited, only appended to.

### 3.4 Restaurant settings

Follow the merged settings pattern (`settings.interfaces.ts` already hosts
`AppSettings` / `QuotationSettings` / `ReturnSettings`…). Add:

```ts
export interface RestaurantSettings {
  serviceChargePercent: number;      // default 0
  waiterCanSettle: boolean;          // default true
  kitchenStations: string[];         // e.g. ["KITCHEN", "BAR"]; default ["KITCHEN"]
  defaultCoversPrompt: boolean;      // ask for covers when opening a tab
}
```

Plus DTO fields on `update-settings.dto.ts` (all optional — retail tenants never send
them) and defaults in the service.

**Deliverables:** 1 migration (`add_business_vertical` + role enum values), guard +
decorator, permissions append, settings section. Retail regression risk: ~zero.

## 4. Phase 1 — Menu domain (`modules/menu`)

New models, no overlap with `Product`:

```prisma
model MenuCategory {
  id String @id @default(cuid())
  tenantId String
  name String
  sortOrder Int @default(0)
  isActive Boolean @default(true)
  items MenuItem[]
  // tenant relation + @@index([tenantId])
}

model MenuItem {
  id String @id @default(cuid())
  tenantId String
  categoryId String
  name String
  description String?
  price Decimal @db.Decimal(12, 2)
  station String @default("KITCHEN")       // routes kitchen tickets
  isAvailable Boolean @default(true)        // "86" toggle — day-to-day, not CRUD
  isActive Boolean @default(true)
  imageUrl String?
  productId String?                         // OPTIONAL link → Product for stock depletion
  taxable Boolean @default(true)
  sortOrder Int @default(0)
  modifierGroups MenuItemModifierGroup[]    // explicit join for ordering
}

model ModifierGroup {
  id String @id @default(cuid())
  tenantId String
  name String                                // "Cooking temp", "Extras"
  minSelect Int @default(0)                  // 1 = required choice
  maxSelect Int @default(1)                  // >1 or 0=unlimited for multi-select
  modifiers Modifier[]
}

model Modifier {
  id String @id @default(cuid())
  groupId String
  name String                                // "Medium rare", "Extra cheese"
  priceDelta Decimal @default(0) @db.Decimal(12, 2)
  isActive Boolean @default(true)
  sortOrder Int @default(0)
}
```

**Endpoints** (all `@RequireVertical(RESTAURANT)`):

| Method | Route | Permission |
|---|---|---|
| GET | `/menu` (full tree: categories → items → modifier groups, one call for the POS) | `menu:read` |
| CRUD | `/menu/categories`, `/menu/items`, `/menu/modifier-groups`, `/menu/modifiers` | `menu:manage` |
| POST | `/menu/items/:id/availability` (86 / un-86) | `menu:read`² |

² Availability toggling is an operational action a waiter/kitchen may perform.

Image upload for menu items reuses `StorageService` verbatim (same controller pattern
as product images).

**Deliverables:** 1 migration, menu module (controller/service/repo/DTOs), tests for
tree assembly + modifier constraints.

## 5. Phase 2 — Floor plan (`modules/tables`)

```prisma
model DiningTable {
  id String @id @default(cuid())
  tenantId String
  branchId String
  name String                // "T1", "Patio 3"
  area String?               // "Main hall", "Terrace"
  capacity Int @default(4)
  sortOrder Int @default(0)
  isActive Boolean @default(true)
  tabs Tab[]
  @@unique([branchId, name])
}
```

**A table can host multiple OPEN tabs at once** — shared/communal tables, counter
seating, or separate parties seated together each keep their own tab (and later,
their own bill). Table *status* is therefore derived, not stored: a table is
occupied iff it has ≥ 1 OPEN tab (`GET /tables` computes via join, returning the
open-tab count and combined covers per table for the floor map). Avoids status
drift and needs no per-table bookkeeping.

**Endpoints:** `GET /tables` (live free/occupied + open tabs per table: tab number,
label, covers, running total — what a floor map renders), CRUD under `table:manage`.

**Deliverables:** 1 migration, tables module, occupancy query test.

## 6. Phase 3 — Tabs and rounds (`modules/tabs`) — the core

### 6.1 Models

```prisma
enum TabStatus { OPEN CLOSED VOID }
enum TabItemStatus { PENDING FIRED VOIDED }   // PENDING = held, not yet sent to kitchen

model Tab {
  id String @id @default(cuid())
  tenantId String
  branchId String
  tableId String
  openedById String            // waiter (User)
  status TabStatus @default(OPEN)
  covers Int @default(1)
  label String?                // distinguishes parties sharing a table: "Party A", "John"
  note String?
  tabNumber String             // "T-000123", same nextNumber pattern as sales
  version Int @default(1)      // optimistic concurrency for multi-device edits
  openedAt DateTime @default(now())
  closedAt DateTime?
  saleId String? @unique       // set when settled — THE junction to retail pipeline
  rounds TabRound[]
  items TabItem[]
  @@index([tenantId, status]) @@index([tableId])
}

model TabRound {
  id String @id @default(cuid())
  tabId String
  roundNumber Int
  firedAt DateTime?            // null until sent to kitchen
  firedById String?
  items TabItem[]
}

model TabItem {
  id String @id @default(cuid())
  tabId String
  roundId String
  menuItemId String
  nameSnapshot String          // denormalized like SaleItem.productName
  unitPrice Decimal @db.Decimal(12, 2)   // price + modifier deltas at order time
  quantity Decimal @db.Decimal(12, 3)
  seat Int?
  note String?                 // "no onions" free text
  status TabItemStatus @default(PENDING)
  voidReason String?
  voidedById String?
  modifiers TabItemModifier[]  // snapshot of chosen modifiers (name + priceDelta)
}
```

### 6.2 Concurrency rules (multiple devices, one tab)

- Every mutation is a `$transaction` that re-reads the tab `FOR UPDATE`-equivalent
  (Prisma `updateMany({ where: { id, status: 'OPEN', version } })` and checks
  `count === 1`, incrementing `version`) — a stale device gets 409 and refetches.
  Same conditional-update idea already proven by `decrementStock`.
- **Multiple OPEN tabs per table are allowed by design** (shared tables / separate
  parties). No uniqueness constraint on (table, OPEN); each tab is independent —
  its own rounds, its own kitchen tickets, its own settlement. Concurrency is
  per-tab (the `version` field), so parties at the same table never contend.
- To keep parties distinguishable, opening a second tab on an occupied table
  prompts for a `label` (service enforces: label required when the table already
  has an open tab — the first tab may omit it). Every waiter-facing view and
  kitchen ticket shows `table · label` (e.g. "T4 · Party B").
- Item voids after firing require `tab:void-item` and keep the row (audit) with
  `VOIDED` status; pre-fire removals hard-delete.

### 6.3 Endpoints

| Method | Route | Notes |
|---|---|---|
| POST | `/tabs` | open (tableId, covers, label?) — multiple open tabs per table allowed; label required once the table already has one |
| GET | `/tabs?status=OPEN&tableId=` | floor/board views (a shared table lists all its tabs) |
| GET | `/tabs/:id` | full tab: rounds, items, running totals |
| POST | `/tabs/:id/items` | add items to the current un-fired round (creates round if needed); body mirrors cart-line shape + `modifierIds`, `seat`, `note` |
| POST | `/tabs/:id/fire` | fire the pending round → sets `firedAt`, creates kitchen tickets (Phase 4) |
| PATCH | `/tabs/:id/items/:itemId` | qty/note/seat while PENDING |
| POST | `/tabs/:id/items/:itemId/void` | after firing; managerial |
| POST | `/tabs/:id/transfer` | move to another table |
| POST | `/tabs/:id/close` | settle → Phase 5 |
| POST | `/tabs/:id/void` | abandon tab (managerial, reason required) |

Totals (`tabs.calc.ts` + spec): items → subtotal, per-line modifiers included in
`unitPrice`, order-level discount via the existing `DiscountsService` approval flow,
`serviceChargePercent` from settings, tax from settings — mirroring `computeCart`'s
rounding helpers so a closed tab and a retail sale compute money identically.

**Deliverables:** 1 migration, tabs module, calc spec, concurrency tests (two
simultaneous `addItems` / double-close via parallel requests).

## 7. Phase 4 — Kitchen tickets (`modules/kitchen`)

Reuse the print-job queue; this is what it exists for.

- `PrintJobType` gains `KITCHEN_TICKET` (additive enum migration — precedent:
  `RETURN_RECEIPT` was added the same way).
- `PrintJob` gains nullable `station String?` and nullable `tabId String?`
  (existing print jobs unaffected).
- **Firing a round** (Phase 3's `/tabs/:id/fire`) renders one ticket per station
  represented in that round (items grouped by `MenuItem.station`): big-font item
  lines, modifiers, seat numbers, table name **plus tab label/number** (so two
  parties sharing T4 produce unambiguous tickets), waiter, time. HTML template in
  `kitchen-ticket.template.ts` (same approach as `return-receipt.template.ts`).
  Ticket creation happens inside the fire transaction — a round is never fired
  without its tickets enqueued.

**Endpoints:**

| Method | Route | Consumer |
|---|---|---|
| GET | `/kitchen/tickets?station=KITCHEN&status=PENDING` | KDS screen or print agent |
| POST | `/print-jobs/:id/mark-printed` | already exists — reused |

**Physical printing** is intentionally out of the backend's body: a small print-agent
daemon on the venue LAN polls the endpoint above and drives ESC/POS printers, marking
jobs printed. The backend contract (poll + ack) is fully defined by this phase; the
agent is a separate deliverable. A browser-based KDS (kitchen display) works with
zero extra backend work and is the recommended v1.

**Deliverables:** 1 migration (enum value + 2 nullable columns), kitchen module
(feed endpoint + template), fire-transaction integration.

## 8. Phase 5 — Closing a tab into the sales pipeline

The junction point. Goal: a settled tab **is** a `Sale`, so receipts, reports,
dashboards, refunds/returns, and QuickBooks flow untouched.

### 8.1 The one retail-table change (carefully)

`SaleItem.productId` is currently required. Tab items reference menu items, not
products. Change (additive, nullable):

```prisma
model SaleItem {
  productId  String?        // was required — now nullable
  menuItemId String?        // new, nullable
  // productName / unitPrice / quantity / discounts / totals — unchanged
}
model Sale {
  tabId String? @unique     // back-reference for "which tab produced this sale"
}
```

Safety: retail writes **always** set `productId` (unchanged code path in
`toSaleItemCreate`); a service-level invariant (`productId XOR menuItemId` must be
present) replaces the DB-level requirement. Existing rows are untouched; the column
merely becomes nullable. This is the single schema modification to a retail table in
the whole plan — it gets its own migration and explicit regression tests (create
retail sale, report export, return flow) before anything builds on it.

### 8.2 Close flow (`/tabs/:id/close`)

Inside one transaction:
1. Guard: tab OPEN, no PENDING (un-fired) items — fire or remove them first.
2. Compute totals via `tabs.calc.ts` (discount approvals enforced as in retail).
3. Create the `Sale` (`status COMPLETED`, `tabId`, items with `menuItemId`,
   payments array identical to `CompleteSaleDto` semantics — cash/card/split/partial
   reuse the exact `PaymentInput` shape) + `enqueueSaleSync` — **calling the existing
   `SalesRepository.createCompleted` extended to accept menu-item lines**, not a
   parallel implementation.
4. Mark tab CLOSED, set `saleId`.
5. Optional stock depletion: for tab items whose `MenuItem.productId` is set,
   run the existing `decrementStock` (non-blocking variant: restaurants often sell
   below-zero; controlled by `trackInventory` on the linked product as today).

Receipt printing: `POST /receipts/:saleId/customer` already works once a Sale exists.

### 8.3 QuickBooks

`SyncJob.type` is a plain string — **no migration needed** for a new job type.
Register a `RestaurantSalesSyncHandler` (`type: 'RESTAURANT_SALES_SYNC'`) in the
existing worker registry. v1 behavior mirrors the retail mock-sync (deterministic
`QBO-…` ids, marks SYNCED) with the real implementation posting a Sales Receipt of
category-level service lines (menu items don't exist as QBO inventory items).
`enqueueSaleSync` gains an optional type parameter — default unchanged for retail.

**Deliverables:** 2 migrations (SaleItem nullable + Sale.tabId; nothing else),
close-flow implementation, sync handler, the retail regression suite run in full.

## 9. Phase 6 — Dashboards and reporting

- `GET /dashboard/stats` stays retail-neutral; add `GET /dashboard/restaurant-stats`
  (open tabs, covers today, today's revenue — revenue reuses the same Sale
  aggregates because closed tabs ARE sales).
- The existing sales report (`GET /sales/report`) already includes tab-born sales
  automatically. Add an optional `origin=RESTAURANT|RETAIL` filter (derived from
  `tabId IS NOT NULL`) — additive query param, default unchanged.

## 10. Migration inventory (all additive)

| # | Migration | Touches retail data? |
|---|---|---|
| 1 | `add_business_vertical_and_roles` (Tenant.vertical, UserRole +WAITER/KITCHEN) | default-only |
| 2 | `add_menu_domain` (4 new tables) | no |
| 3 | `add_dining_tables` | no |
| 4 | `add_tabs_and_rounds` (4 new tables + enums) | no |
| 5 | `add_kitchen_tickets` (PrintJobType +KITCHEN_TICKET, PrintJob.station/tabId nullable) | nullable-only |
| 6 | `relax_sale_item_product_link` (SaleItem.productId nullable, +menuItemId; Sale.tabId) | **the one to watch** — nullable-only, but on hot tables; ship alone |

Postgres enum value additions and nullable column additions are non-locking and safe
on live data. Migration 6 ships in its own release with the regression suite green
before and after.

## 11. Non-breaking guarantees and test plan

**Retail regression checklist (run after every phase, automated where possible):**
- Full jest suite (29 existing tests + new ones per phase).
- Smoke: login (password + PIN + refresh), product CRUD + image upload (S3),
  complete retail sale → stock decrement → sync SYNCED, oversell 400, sales report
  PDF/XLSX, quotations + returns endpoints, dashboard stats.
- A retail tenant calling any restaurant endpoint → 403 (VerticalGuard test).
- Contract check: no existing DTO gains a required field; no existing response
  shape changes (the OpenAPI-less equivalent: golden-response tests for
  `/sales`, `/products`, `/dashboard/stats`).

**New-code testing pattern:** pure calc modules with specs (tab totals, service
charge, modifier pricing), service specs with mocked repositories
(`quotations.service.spec.ts` is the template), and concurrency tests for tab
mutations and double-close.

## 12. Suggested sequencing

Phases are dependency-ordered; each lands independently shippable:

0. Platform prep (vertical flag, guard, roles, settings) — small
1. Menu domain — medium
2. Tables — small
3. Tabs & rounds — **large** (the heart; concurrency care)
4. Kitchen tickets — medium
5. Close-into-sale + QBO handler — medium (contains the one risky migration)
6. Restaurant dashboard/report filters — small

A working end-to-end demo (open tab → order rounds → kitchen ticket feed → close →
receipt + report) exists after Phase 5; Phases 1–4 alone already demo the service
flow with tickets.

## 13. Out of scope (deliberately, for now)

- Reservations / waitlists; table merge & split-tab-by-seat billing (model fields
  `seat` already captured to enable it later); recipe/ingredient-level inventory;
  happy-hour price schedules; the physical print-agent daemon (contract defined
  here, implementation separate); the restaurant web/PWA front-end; KDS UI.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migration 6 (nullable `SaleItem.productId`) regresses retail writes | Ships alone; service-level XOR invariant; golden retail regression suite before/after |
| Tab concurrency bugs (two devices, one tab) | Version-checked conditional updates in transactions (proven pattern here); dedicated parallel-request tests |
| Enum migrations on shared enums (`UserRole`, `PrintJobType`) | Additive values only — Postgres-safe; precedent already in repo (`RETURN_RECEIPT`) |
| Scope creep toward "configurable generic POS" | Principle 2: vertical logic only in vertical modules; shared modules reject vertical conditionals in review |
| Shared release cadence (one deploy serves both verticals) | Accepted at current scale; module separation keeps later extraction possible |
