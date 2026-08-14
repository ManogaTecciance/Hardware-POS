# AxloPOS convergence plan — one catalogue, one settlement document, N pluggable domains

**Status:** in delivery. **Phase 0 shipped** (D56/D57, 2026-08-14): domain
packs, capabilities on the profile, the seven inline predicates deleted, the
HOTEL defects D-1/D-2 fixed and browser-verified, `TILE_SHOP`/`RETAIL` removed
from the enum, and the pilot classified as an explicit HARDWARE tenant.
Phases 1+ remain proposals.
**Author:** architecture review, 2026-08-14.
**Scope:** `apps/api`, `apps/web`, `packages/database`, `packages/shared`.
**Extends:** D28, D31, D36, D37, D44, D45, D46, D52, D55.

---

## 0. How to read this document

- **§1–§3** — the analysis: what exists, what is genuinely shared, what is
  accidentally duplicated, and where the real seam lies.
- **§4** — **the domain pack architecture.** How a fourth, fifth and tenth
  vertical get added without touching fifteen files. Read this even if you read
  nothing else.
- **§5** — the capability model that replaces business-type comparisons.
- **§6** — seven live defects found during the review, four of them caused
  directly by the absence of §4.
- **§7–§10** — target database, REST API and frontend design.
- **§11–§16** — phased plan, **production data migration (§12)**, test obligations, open decisions, risks, non-goals.

Every claim about current behaviour was verified by reading the source at the
path cited. Where code and an existing decision record disagree, the
disagreement is called out.

---

## 1. Executive summary

### 1.1 The three questions, answered

**"Can products for both live in the same tables?"** Yes — and they already
partly do. D45 moved restaurant item authoring onto `Product`, added
`prepMinutes` / `dietaryTags` / `foodType`, and added `ProductModifierGroup` /
`ProductStationLink` as peers of the `MenuItem` junctions. What was never
finished is retiring the old model, so the system is now in the most expensive
possible state: **both catalogues live, every write path aware of both, and a
`sourceKind` discriminator threaded through the order pipeline.**

**"Can they be created, edited and returned from the same API?"** Yes. The
catalogue routes under `/restaurant/*` (`modifier-groups`, `menu-items`,
`menu-sections`) are not restaurant concepts — a hardware store selling
"cut to length +$4" is using a modifier group. They belong under `/products`.

**"Is the transaction side shared?"** No, and it is worse than the catalogue:

> **A restaurant sale writes a `Sale` header with zero `SaleItem` rows.**

Everything downstream of the line items — item-level reporting, returns,
receipts, accounting sync — is therefore retail-only, which is why a second
reporting stack (`restaurant-reports`) had to be built reading
`RestaurantOrderItem` directly. Fixing this is the highest value-per-line change
in the plan and it is cheap.

### 1.2 The question that matters more than all three

The review was asked to generalise across **two** verticals. Doing that alone
would be a mistake, because the cost of adding the *third* is already visible in
the codebase and it is high.

**Adding one new vertical today touches fifteen places, and only four of them
fail the build if you forget.**

| # | Place | Compile-checked? |
|---|---|---|
| 1 | `BusinessType` enum + Prisma migration | n/a |
| 2 | `BUSINESS_PROFILE_PRESETS` (`packages/database`) | ✅ `Record<BusinessType,…>` |
| 3 | `DEFAULT_MODULES_BY_BUSINESS_TYPE` (`api/platform.constants.ts:96`) | ✅ |
| 4 | `BUSINESS_TYPE_LABELS` (`web/platform-labels.ts:16`) | ✅ |
| 5 | Web `BusinessType` string union (`web/platform-api.ts:23`) | ✅ (but a *second authority* — hand-synced with Prisma) |
| 6 | `NAV_BY_BUSINESS_TYPE` (`web/nav.ts:274`) | ❌ `Record<string,…>` with `?? RETAIL_NAV` |
| 7 | `roleTemplatesForBusinessType` (`shared/role-templates.ts:254`) | ❌ `if` chain on a `string` |
| 8 | `WORKSPACE_TEMPLATES` (`api/workspace-templates.ts`) | ❌ array |
| 9 | `resolveBusinessKind` (`web/product-presentation.ts:60`) | ❌ `if` chain |
| 10–15 | Six inline `businessType === 'RESTAURANT' \|\| 'CAFE' \|\| 'BAKERY'` predicates in page bodies | ❌ |

Eleven of the fifteen fail **silently**. `NAV_BY_BUSINESS_TYPE` falls back to the
retail navigation; `resolveBusinessKind` falls back to `'RETAIL'`; the six inline
predicates fall back to the retail branch. A new domain that forgets them looks
like a *retail* tenant in exactly the places a user would notice last.

This is not hypothetical. **HOTEL, added three commits ago, missed seven of them
— §6.** The existing doc comment in `workspace-templates.ts` asserts that "the
compiler demands every one of them, because each map is a total
`Record<BusinessType, …>`". That claim is true of four maps and false of the
rest, and the false half is where HOTEL broke.

### 1.3 The proposal

Three layers, each with a different rule for how it varies.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LAYER 1 — INVARIANT CORE                    varies: never                │
│ Tenant · Branch · Register · User · Role · Customer · Product ·          │
│ ProductVariant · ModifierGroup · BranchInventory · StockMovement ·       │
│ Sale · SaleItem · Payment · Receipt · AuditLog · DocumentSequence        │
│ One schema, one API, one implementation. Every domain uses it as-is.     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────────────────┐
│ LAYER 2 — PLUGGABLE BEHAVIOUR               varies: by provider          │
│ InventoryProvider (exists, D28) · AccountingProvider (exists, D28)       │
│ FulfilmentProvider (NEW) · PricingProvider (NEW, later)                  │
│ A new behaviour = a new implementation of an existing interface.         │
│                                                                          │
│ ⚠ QuickBooks is ONE domain's integration (hardware/retail only) and      │
│   must not appear in Layer 1. Today it does — §4.9.                      │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────────────────┐
│ LAYER 3 — DOMAIN PACK                       varies: by declaration       │
│ One DomainDescriptor file per vertical. Declares modules, navigation,    │
│ role templates, capabilities, catalogue attribute schema, fulfilment     │
│ provider, seed data, workspace-template copy.                            │
│ A new vertical = ONE new file + ONE registry line + ONE enum value.      │
└──────────────────────────────────────────────────────────────────────────┘
```

**One catalogue, one settlement document, N pluggable domains.**

### 1.4 The extension contract

The plan's central promise, stated so it can be tested:

> **Adding a vertical that composes existing behaviours** — a hotel F&B outlet,
> a bakery, a grocery, a garden centre — requires: one `DomainDescriptor` file,
> one line in the registry, one `BusinessType` enum value and its migration.
> **Nothing else.** No page edits, no nav map edits, no role-template edits,
> no `if` chains.
>
> **Adding a vertical that introduces a genuinely new behaviour** — a salon
> selling appointment slots, a hotel selling room-nights, a workshop selling
> staged repair jobs — additionally requires one new `FulfilmentProvider`
> implementation and its own decision record. It still requires **zero** edits
> to the domains that already exist.

§4.7 works both cases through end-to-end.

### 1.5 Effort at a glance

| Phase | Theme | Schema | Est. | Unblocks |
|---|---|---|---|---|
| **0** | Domain packs + capabilities; fix the HOTEL defects | none | 5–8 d | every phase below, and every future vertical |
| **1** | Universal settlement document (`SaleItem` for all) | additive | 5–8 d | reporting, returns, receipts, sync |
| **2** | One money engine (Decimal, one calculator) | additive | 3–5 d | correctness |
| **3** | Catalogue convergence: retire `MenuItem` writes | additive + backfill | 8–12 d | one API, one wizard |
| **4** | `FulfilmentProvider` abstraction | none | 5–8 d | domains 4..N |
| **5** | Unified catalogue REST surface | none (aliases) | 4–6 d | client simplification |
| **6** | **QuickBooks quarantine** — vendor data leaves the core tables | additive + deferred drop | 6–10 d | domains 4..N stop inheriting QBO columns |
| **7** | Catalogue attribute extension (`attributes` + schema registry) | additive | 5–8 d | domain-specific fields without migrations |
| **8** | Recipes / depletion for composed items | additive | 8–15 d | true stock control |
| **9** | Collections (generalised menus) | additive | 5–8 d | channel curation, all domains |

Phases 0–2 are independently shippable and deliver most of the near-term value.
Phase 0 and Phase 4 are what make verticals 4..N cheap.

---

## 2. Current state

### 2.1 Evidence base

| Area | Files read |
|---|---|
| Schema | `packages/database/prisma/schema.prisma` — 3,197 lines, 92 models, 34 enums |
| Catalogue | `modules/products/**`, `modules/categories/**`, `modules/menu/**`, `modules/restaurant/pos-catalogue.service.ts` |
| Transactions | `modules/sales/**`, `modules/table-sessions/**`, `modules/takeaway/**`, `modules/billing/**` |
| Inventory | `modules/providers/inventory/**`, `modules/inventory-receipts/**` |
| Money | `sales/sales.service.ts`, `quotations/quotations.calc.ts`, `restaurant/restaurant-totals.ts` |
| Reporting | `sales/sales-report.service.ts`, `restaurant-reports/**` |
| Domain routing | `modules/platform/**`, `web/lib/nav.ts`, `web/lib/products/product-presentation.ts`, `shared/types/role-templates.ts` |
| Decisions | `docs/restaurant-pos/00-decisions.md` — D25–D55, ~1,700 lines |
| Routes | `docs/restaurant-pos/route-module-matrix.md` — 263 routes, 44 controllers |

### 2.2 Already genuinely shared (Layer 1 candidates)

| Domain | Models | Note |
|---|---|---|
| Tenancy | `Tenant`, `TenantBusinessProfile`, `TenantModule`, `TenantSettings` | D28/D31 provider routing already generalises inventory + accounting |
| Locations | `Branch`, `Register`, `BranchAccess` | restaurant floor hangs off `Branch` |
| Identity | `User`, `Role`, `Permission`, `RefreshToken` | D36/D37/D40 — roles are per-tenant **rows**, already domain-neutral |
| Customers | `Customer` | both flows attach the same record |
| Catalogue *(partial)* | `Product`, `ProductVariant`, `ProductCategory`, `ProductSubcategory` | D45 put restaurant fields on `Product` |
| Modifiers | `ModifierGroup`, `ModifierOption` | tenant-scoped and reusable **by design** |
| Promotions | `Promotion`, `PromotionItem` | keyed on `Product`, already catalogue-generic |
| Inventory | `BranchInventory`, `StockMovement` | one ledger, one reason enum |
| Purchasing | `Supplier`, `InventoryReceipt`, `InventoryReceiptLine` | restaurant purchasing already uses the retail path |
| Settlement *(header only)* | `Sale`, `Payment` | restaurant close writes a real `Sale` (D52) |
| Documents | `Receipt`, `PrintJob`, `DocumentSequence` | one sequence numbers both |

That the identity, purchasing and promotions layers are already domain-neutral is
the strongest evidence the convergence is tractable rather than a rewrite.

### 2.3 Duplicated

| Concern | Retail | Restaurant | Verdict |
|---|---|---|---|
| Sellable item | `Product` (+`ProductVariant`) | `MenuItem` **and** `Product` | accidental — collapse |
| Item ↔ modifier | `ProductModifierGroup` | `MenuItemModifierGroup` | accidental — collapse |
| Item ↔ station | `ProductStationLink` | `MenuItemStationLink` | accidental — collapse |
| Grouping | `ProductCategory`/`Subcategory` | `Menu`/`MenuSection` | partly real — taxonomy vs curation (§8.5) |
| POS read model | `GET /products/search` | `GET /restaurant/pos-catalogue` | accidental — collapse |
| Transaction lines | `SaleItem` | `RestaurantOrderItem` | real split, **wrong place** (§3.2) |
| Money calculator | `sales.service.ts` (float) | `restaurant-totals.ts` (Decimal) | accidental — collapse |
| Charge config | `TenantSettings.data` (JSON) | `RestaurantBranchConfig` (columns) | accidental — collapse |
| Item reporting | `sales-report.service.ts` | `restaurant-reports.service.ts` | consequence of the split |
| Cart (web) | `lib/cart.ts` | `lib/pos-cart.tsx` | accidental |
| Catalogue client (web) | `lib/products-api.ts` | `lib/restaurant/pos-catalogue-api.ts` | accidental |

Code volume: restaurant-only API modules total **~9,300 lines**; shared modules
**~10,100**. Roughly **2,900** of the restaurant lines (`menu` at 1,500,
`restaurant-reports` at 357, catalogue-shaped parts of `restaurant` and
`billing`) are candidates for deletion or absorption. The rest — tables, rounds,
kitchen tickets, reservations — is genuine domain and stays.

### 2.4 Divergent for good reasons — do not converge

- **Fulfilment lifecycle.** Retail: one atomic act. Restaurant: `TableSession` →
  `Order` → N × `OrderRound` → `KitchenTicket` → serve → bill → pay.
- **Floor domain.** `DiningArea`, `RestaurantTable`, `OpenTableMember`,
  `TableReservation`.
- **Kitchen domain.** `KitchenStation`, `KitchenTicket`, `KitchenPrinter`.
- **Bill splitting.** `BillSplit`, `BillSplitItem` (D51).
- **Accounting provider.** D28/D31 abstract this correctly already.

These are Layer 2/Layer 3 concerns, not Layer 1 — which is exactly the point of
the three-layer split.

---

## 3. The thesis

### 3.1 The seam is not "retail vs restaurant"

Drawing the line there is what produced the duplication, and it will not survive
a third vertical. The durable seam is:

> **Catalogue and money are invariant. Fulfilment is pluggable. Presentation is
> declared.**

A hardware store selling a cylinder with "cut to 3 keys +$6" and a restaurant
selling a burger with "add bacon +$2" are using the same feature. Two
implementations exist because of historical sequencing, not domain difference.

Conversely, "send half this order to the grill and half to the bar, then let a
second waiter add a round twenty minutes later, then split the bill three ways"
has no retail counterpart — and a salon's "book Tuesday 3pm with Anna for 90
minutes" has no counterpart in *either*. Fulfilment is where verticals genuinely
differ, so it gets an interface rather than a merge.

### 3.2 Why the transaction split is in the wrong place

```
retail:      cart ──────────────────────────► Sale + SaleItem
restaurant:  Order + RestaurantOrderItem ───► Sale (header only)
```

Verified consequences:

1. `restaurant-reports.service.ts:109,219` reads `restaurantOrderItem` for
   item analytics because `saleItem` is empty for those sales.
2. `returns.repository.ts:316` builds returns from `saleItems` — so **a
   restaurant sale cannot be returned** through the shared path at all.
3. `billing.service.ts:64,388` builds the bill from `restaurantOrderItem`;
   `receipts.repository.ts` builds the retail receipt from the `Sale` graph. Two
   pipelines for the same piece of paper.
4. `Sale` has **no `channel` column**, so a settled takeaway is
   indistinguishable from a settled dine-in without joining back through the
   session.
5. Item-level profitability, stock-vs-sales reconciliation, and item-level
   accounting sync are structurally unavailable to any table-service tenant.

The fix is **not** to merge the workflows. It is to make the settlement document
universal: project the operational lines into `SaleItem` at close. The
operational record stays where it is; the financial record becomes complete.

Crucially, this is also what makes vertical #4 cheap: a salon's appointment, a
hotel's room-night and a workshop's repair job all settle into the same
`Sale`/`SaleItem`, so every one of them inherits reporting, returns, receipts
and accounting for free.

### 3.3 Why not one `Order` table for every domain

Considered and rejected. A unified `Order` with `fulfilmentMode` would give
retail an order row, an order-number sequence and a concurrency token it never
reads; would make `OrderRound` nullable-everything for retail (or fabricate a
synthetic single round — a lie in the data); and would migrate every completed
retail sale in the system for a tidier diagram.

**`Sale`/`SaleItem` is the universal document. The *operational* order model is
owned by the fulfilment provider** and may differ per domain — `RestaurantOrder`
for table service, nothing at all for immediate, an `Appointment` for a salon.
That is the same shape as `InventoryProvider`: one interface, several storage
realities behind it.

---

## 4. The domain pack architecture

This section is the answer to "make sure the plan accommodates future
templates/domains".

### 4.1 What a domain actually varies

Cataloguing every axis on which RESTAURANT differs from HARDWARE today, plus the
axes a plausible fourth domain would need:

| Axis | Today | Needed by a salon | Needed by a hotel (real) |
|---|---|---|---|
| Enabled modules | `DEFAULT_MODULES_BY_BUSINESS_TYPE` | `APPOINTMENTS` | `ROOMS`, `HOUSEKEEPING` |
| Navigation | `NAV_BY_BUSINESS_TYPE` | Calendar-first | Front desk, arrivals |
| Role templates | `roleTemplatesForBusinessType` | Stylist, Receptionist | Front desk, Housekeeper |
| Profile preset | `BUSINESS_PROFILE_PRESETS` | LOCAL / NONE | LOCAL / NONE |
| Workspace template copy | `WORKSPACE_TEMPLATES` | name + description | name + description |
| Display label | `BUSINESS_TYPE_LABELS` | "Salon" | "Hotel" |
| Product wizard chrome | `resolveBusinessKind` | duration, resource | room type, occupancy |
| Fulfilment lifecycle | 6 inline predicates | book → serve → settle | reserve → stay → fold to folio |
| Catalogue attributes | — | `durationMinutes`, `staffSkill` | `bedCount`, `viewType` |
| Sellable behaviour | `Product.type` (QBO string) | time slot | night, occupancy-priced |
| Channels | `RestaurantOrderChannel` | walk-in, booked | direct, OTA |
| Charges | `RestaurantBranchConfig` | — | city tax, resort fee |
| Demo seed | `seed.ts` if-chain | chairs + services | rooms + rates |

Thirteen axes. Today they live in thirteen unrelated places. That is the problem.

### 4.2 The `DomainDescriptor`

One file per vertical, in `packages/shared` so both the API and the web app read
the same declaration.

```
packages/shared/src/domains/
  domain.types.ts        — the interface below
  registry.ts            — DOMAIN_REGISTRY: Record<BusinessType, DomainDescriptor>
  hardware.domain.ts     — HARDWARE (the vertical's one value — §4.8.1)
  food-service.domain.ts — RESTAURANT, CAFE, BAKERY
  hotel.domain.ts        — HOTEL (today: re-declares food service; diverges later)
  general.domain.ts      — GENERAL
```

```ts
export interface DomainDescriptor {
  /** The BusinessType values this descriptor serves. */
  readonly businessTypes: readonly BusinessType[];

  /** Human label, used everywhere a business type is displayed. */
  readonly label: string;

  /** Workspace-template presentation for the platform console (D55). */
  readonly template: {
    readonly name: string;
    readonly description: string;
    /** Order in the picker. Absent = not offered as a template. */
    readonly order?: number;
  };

  /** The inventory/accounting pair a new tenant of this domain gets. */
  readonly profile: {
    readonly inventoryMode: InventoryMode;
    readonly accountingProvider: AccountingProviderKind;
  };

  /** Modules enabled by default. */
  readonly modules: readonly ModuleKey[];

  /**
   * Navigation, declared as data. Icons are referenced BY NAME and resolved
   * through one map on the client — a descriptor in `packages/shared` cannot
   * import a React component, and should not want to.
   */
  readonly navigation: readonly NavGroupSpec[];

  /** Roles seeded into a new tenant. Reuses the existing RoleTemplate shape. */
  readonly roleTemplates: readonly RoleTemplate[];

  /** What this domain's tenants can do (§5). */
  readonly capabilities: TenantCapabilities;

  /** Which FulfilmentProvider implementation serves this domain (§4.5). */
  readonly fulfilment: FulfilmentSpec;

  /** Domain-specific catalogue extensions (§4.6). */
  readonly catalogue: CatalogueSpec;

  /** Demo data for a workspace created from this template. Optional. */
  readonly seed?: DomainSeedSpec;
}
```

```ts
// registry.ts — the ONE place a domain is wired in.
export const DOMAIN_REGISTRY: Record<BusinessType, DomainDescriptor> = {
  HARDWARE:   HARDWARE_DOMAIN,   // §4.8.1 — TILE_SHOP and RETAIL are removed
  GENERAL:    GENERAL_DOMAIN,
  RESTAURANT: FOOD_SERVICE_DOMAIN,
  CAFE:       FOOD_SERVICE_DOMAIN,
  BAKERY:     FOOD_SERVICE_DOMAIN,
  HOTEL:      HOTEL_DOMAIN,
};

export function domainFor(businessType: BusinessType): DomainDescriptor {
  return DOMAIN_REGISTRY[businessType];   // total — no fallback, by design
}
```

**No `??` fallback.** The current `NAV_BY_BUSINESS_TYPE[type] ?? RETAIL_NAV` is
precisely the mechanism that would have silently given a new domain the retail
navigation. A total `Record` with no default means a missing domain is a compile
error, not a wrong screen.

### 4.3 What each existing map becomes

| Today | After |
|---|---|
| `BUSINESS_PROFILE_PRESETS` | `domainFor(t).profile` |
| `DEFAULT_MODULES_BY_BUSINESS_TYPE` | `domainFor(t).modules` |
| `BUSINESS_TYPE_LABELS` | `domainFor(t).label` |
| `NAV_BY_BUSINESS_TYPE` | `domainFor(t).navigation` |
| `roleTemplatesForBusinessType` | `domainFor(t).roleTemplates` |
| `WORKSPACE_TEMPLATES` | derived: `Object.values(DOMAIN_REGISTRY)` filtered on `template.order != null` |
| `resolveBusinessKind` | deleted — components read capabilities |
| 6 inline predicates | deleted — components read capabilities |
| web `BusinessType` union | generated from the Prisma enum (§4.8) |

**Fifteen places become one.** And the vertical they describe becomes one
value: the PO has ruled that the Hardware template and the Tile Shop are the
same entity and there is no Retail template, so `HARDWARE` is the only value
and `TILE_SHOP` / `RETAIL` are removed outright in Phase 0 (§4.8.1) — they are
ten days old and carry zero data, so there is nothing to transition.

### 4.4 Navigation as data

The one non-obvious piece. `NAV_BY_BUSINESS_TYPE` currently holds JSX-adjacent
objects carrying `lucide-react` icon components, so it cannot live in
`packages/shared`. The fix is a name indirection:

```ts
// packages/shared — no React import
export interface NavItemSpec {
  readonly href: string;
  readonly label: string;
  readonly icon: NavIconName;          // 'Package' | 'Utensils' | …
  readonly permission: Permission;
  readonly module?: ModuleKey;
  readonly upcoming?: boolean;
}
export interface NavGroupSpec {
  readonly label: string | null;
  readonly items: readonly NavItemSpec[];
}
```

```ts
// apps/web/src/lib/nav-icons.ts — the only place icons are bound
export const NAV_ICONS: Record<NavIconName, LucideIcon> = { Package, Utensils, … };
```

`resolveNavigation` keeps its existing three filters (business type → module →
permission) and its 38 existing tests; only its *source* changes. The
`NavIconName` union being total over `NAV_ICONS` is compile-checked, so a
descriptor naming an icon that does not exist fails the build.

### 4.5 `FulfilmentProvider` — Layer 2, extending D28's pattern

The codebase already has the right pattern for pluggable behaviour and applies
it to inventory and accounting. Fulfilment is the third axis and the one every
future vertical will need.

```ts
export interface FulfilmentContext {
  tenantId: string;
  branchId: string;
  actorUserId: string;
  channel: OrderChannel;
}

/** What a fulfilment lifecycle must be able to do to settle into a Sale. */
export interface FulfilmentProvider {
  readonly kind: FulfilmentKind;

  /** Open a unit of work. Retail: a no-op handle. Table service: a session. */
  openWorkUnit(tx: Tx, ctx: FulfilmentContext, input: OpenInput): Promise<WorkUnitRef>;

  /** Add sellable lines. Retail: once. Table service: once per round. */
  addLines(tx: Tx, ctx: FulfilmentContext, ref: WorkUnitRef, lines: LineInput[]): Promise<void>;

  /** Everything not yet settled, in the universal line shape. */
  collectSettlementLines(tx: Tx, ref: WorkUnitRef): Promise<SettlementLine[]>;

  /** Release domain resources on settle — free the table, check out the room. */
  releaseResources(tx: Tx, ctx: FulfilmentContext, ref: WorkUnitRef): Promise<void>;

  /** Domain side effects after lines are added — KOT tickets, work orders. */
  dispatch?(tx: Tx, ctx: FulfilmentContext, ref: WorkUnitRef): Promise<void>;
}

export type FulfilmentKind =
  | 'IMMEDIATE'      // counter sale — retail
  | 'TABLE_SERVICE'  // session → order → rounds — food service
  | 'APPOINTMENT'    // future: salon, clinic
  | 'STAY'           // future: hotel rooms, folio
  | 'WORK_ORDER';    // future: workshop, repair
```

Implementations:

- `ImmediateFulfilmentProvider` — wraps today's `sales.service` path.
  `openWorkUnit` returns a transient ref; `collectSettlementLines` returns the
  cart lines.
- `TableServiceFulfilmentProvider` — wraps `table-sessions` + `takeaway`.
  `dispatch` generates kitchen tickets; `releaseResources` frees the table and
  dissolves open tables (D49/D50).

The settlement path becomes domain-neutral:

```ts
const provider = await this.fulfilmentProviders.forTenant(tenantId);
const lines    = await provider.collectSettlementLines(tx, ref);
const totals   = computeDocumentTotals(lines, channel, chargeConfig);
const sale     = await this.settlement.write(tx, { lines, totals, … });  // Sale + SaleItem
await provider.releaseResources(tx, ctx, ref);
```

**Adding vertical #4's lifecycle is then one class implementing one interface.**
It writes its own operational tables if it needs them; it never touches
`sales.service`, `returns`, `receipts` or reporting, because those consume
`SaleItem` and `SaleItem` is Layer 1.

This is where the plan's extensibility genuinely lives. Phase 4.

### 4.6 Catalogue extension without a migration per domain

A hotel needs `bedCount`, `viewType`, `maxOccupancy`. A salon needs
`durationMinutes`, `requiredSkill`. A pharmacy needs `requiresPrescription`,
`scheduleClass`. Adding a column per domain per field does not scale and makes
`Product` unreadable.

**The rule:**

> **Behaviour goes in columns. Description goes in `attributes`.**
>
> If the *engine* must branch on it — inventory depletion, pricing, tax,
> settlement — it is a typed column and a new value is a migration with a
> decision record. If only the *domain UI and reports* read it, it is a
> validated key in `Product.attributes`.

```prisma
model Product {
  // … existing …

  /// Domain-specific attributes, validated against the schema the tenant's
  /// DomainDescriptor declares (`catalogue.attributeSchema`). Never read by
  /// pricing, tax, inventory or settlement — those read typed columns only.
  /// GIN-indexed so domain screens can filter on them.
  attributes Json @default("{}")

  @@index([attributes], type: Gin)
}
```

```ts
// in a DomainDescriptor
readonly catalogue: {
  /** Which sellable behaviours this domain may author. */
  readonly sellableKinds: readonly SellableKind[];
  /** Declarative field list — drives wizard rendering AND server validation. */
  readonly attributeSchema: readonly AttributeField[];
};

// hotel.domain.ts
catalogue: {
  sellableKinds: ['STAY_UNIT', 'STOCK_ITEM', 'SERVICE'],
  attributeSchema: [
    { key: 'bedCount',     label: 'Beds',      type: 'integer', min: 1, required: true },
    { key: 'maxOccupancy', label: 'Sleeps',    type: 'integer', min: 1, required: true },
    { key: 'viewType',     label: 'View',      type: 'enum', options: ['Sea', 'Garden', 'City'] },
  ],
}
```

One generic wizard step renders `attributeSchema`; one generic validator checks
the payload server-side. **A new domain's catalogue fields require no migration,
no wizard code and no DTO change.**

Honest trade-off: JSONB gives up foreign keys, typed queries and column-level
constraints. That is why the rule above draws the line where it does — anything
the money or stock engines touch stays a real column. A `attributes` key that
proves hot can be *promoted* to a column later; promotion is additive and easy,
demotion is not.

`sellableKind` itself stays a Prisma enum, because inventory behaviour branches
on it:

```prisma
enum SellableKind {
  STOCK_ITEM     // depletes 1:1 — a bolt, a bottled beer
  COMPOSED_ITEM  // depletes via components (§8.8) — a burger, a gift basket
  SERVICE        // no stock — key cutting, corkage, a delivery fee
  BUNDLE         // one line, several products
  TIME_SLOT      // future: capacity is a calendar, not a quantity
  STAY_UNIT      // future: capacity is a room-night
}
```

`TIME_SLOT` and `STAY_UNIT` are listed now, unused, deliberately: they are the
two shapes we know are coming, and naming them fixes the vocabulary before
someone invents `Product.type = 'Room'`.

### 4.7 Worked examples

#### Case A — a vertical that composes existing behaviour: **GROCERY**

Immediate fulfilment, local inventory, no preparation, but wants modifiers
(deli counter: "sliced thin") and collections (weekly offers).

1. `BusinessType.GROCERY` + additive migration.
2. `packages/shared/src/domains/grocery.domain.ts`:
   ```ts
   export const GROCERY_DOMAIN: DomainDescriptor = {
     businessTypes: ['GROCERY'],
     label: 'Grocery',
     template: { name: 'Grocery / Convenience', description: '…', order: 4 },
     profile: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
     modules: [...RETAIL_CORE_MODULES],
     navigation: RETAIL_NAVIGATION,
     roleTemplates: BUILT_IN_ROLE_TEMPLATES,
     capabilities: {
       ...COMMERCE_BASELINE,
       catalogue: { ...COMMERCE_BASELINE.catalogue, modifiers: true, collections: true },
     },
     fulfilment: { kind: 'IMMEDIATE', channels: ['COUNTER'] },
     catalogue: { sellableKinds: ['STOCK_ITEM', 'BUNDLE', 'SERVICE'], attributeSchema: [] },
   };
   ```
3. One line in `registry.ts`.

**Total: 1 file, 1 line, 1 enum value + migration. Zero edits elsewhere.**
Contrast with today: fifteen places, eleven of them failing silently.

#### Case B — a vertical with a new behaviour: **SALON**

Sells appointment slots against staff capacity. Needs a new lifecycle.

1–3. As Case A, with `fulfilment: { kind: 'APPOINTMENT', … }`, `sellableKinds:
   ['TIME_SLOT', 'STOCK_ITEM', 'SERVICE']`, and an `attributeSchema` carrying
   `durationMinutes` and `requiredSkill`.
4. **New:** `AppointmentFulfilmentProvider` implementing `FulfilmentProvider`,
   plus its own `Appointment` / `StaffSchedule` tables and its own routes under
   `/appointments`.
5. **New:** `ModuleKey.APPOINTMENTS`, its permissions, its nav icon.
6. Its own decision record.

**What it does *not* touch:** `Product`, `SaleItem`, `Payment`, `Receipt`,
`Return`, `sales-report`, the inventory ledger, the money calculator, or any
existing domain's descriptor. Appointments settle into the same `Sale`/`SaleItem`
and inherit reporting, refunds, receipts and accounting sync for free.

That is the test of whether this architecture is worth building, and it passes.

### 4.8 One authority for `BusinessType`

`apps/web/src/lib/platform-api.ts:23` hand-maintains a string union mirroring the
Prisma enum, and `module-key-contract.spec.ts` already parses it with a regex
(and broke twice during D55 when a comment landed inside the union).

**Proposal:** generate the web union from the Prisma enum at build time into
`packages/shared`, and have both workspaces import it. This removes a whole class
of "the web forgot the new domain" bugs and removes the brittle regex parse.

#### 4.8.1 Consolidation: one business type per template (PO, 2026-08-14)

**Stated decision: the Hardware template and the Tile Shop are the same
entity, and there is no Retail template.** `HARDWARE` becomes the vertical's
one value; `TILE_SHOP` and `RETAIL` are **removed** — not deprecated, removed.

**Where the three values came from.** The `BusinessType` enum is ten days old
(migration `20260804121830_add_tenant_platform_profile`, 2026-08-04). It was
created in one stroke with the whole taxonomy — `TILE_SHOP, HARDWARE, RETAIL,
RESTAURANT, CAFE, BAKERY, GENERAL` — when the restaurant platform work began:

- `TILE_SHOP` exists because the original pilot customer literally is a tile
  shop. The platform architecture chose "a tenant with **no** profile row
  behaves exactly as before" as its backward-compatibility contract, and the
  code-level default that implements it was named after the real business.
- `HARDWARE` and `RETAIL` were speculative — plausible retail-ish types named
  up front. `HARDWARE` was first actually used three commits ago, when D55
  made it the workspace template's type. `RETAIL` has never been used by
  anything.

So this is not legacy being cleaned up; it is speculation being withdrawn
before it hardens into legacy.

**Why outright removal is safe here.** Three facts, all verified:

1. `BusinessType` is referenced by exactly **one column** in the database:
   `TenantBusinessProfile.businessType`.
2. **Zero rows** carry `TILE_SHOP`, `HARDWARE` or `RETAIL`. The live hardware
   tenant has *no profile row at all* — its business type is the code constant
   `LEGACY_TENANT_DEFAULTS.businessType`, not data.
3. Every code reference to `TILE_SHOP` is a total-map entry that §4.3
   dissolves anyway, plus two sites: the legacy-default constant
   (`platform.constants.ts:30`) and one repository fallback
   (`business-profile.repository.ts:115`). `RETAIL` has map entries only.

An earlier draft of this section proposed deprecate-now, drop-later. That
two-step discipline is right for values with data and history behind them; for
ten-day-old values with neither, it manufactures a transition where none is
needed and leaves the total maps answering for ghosts.

**Steps (Phase 0, one PR):**

1. Repoint `LEGACY_TENANT_DEFAULTS.businessType` and the repository fallback
   from `TILE_SHOP` to `HARDWARE`. Behaviourally identical — both resolved to
   the same navigation, modules, preset and roles. The one visible effect:
   the Settings → Business label for legacy tenants reads "Hardware store"
   instead of "Tile shop". Named in the decision record.
2. Migration removing the two values. Postgres cannot `DROP` an enum value in
   place, so the generated migration recreates the type
   (`BusinessType_new` → column `ALTER … TYPE … USING` → drop old → rename).
   With one tiny table and zero affected rows this is trivial, but it is
   **non-additive**, so: it gets its own decision record (per CLAUDE.md), and
   the per-migration proof in `provider-contract.spec.ts` is extended to
   permit exactly this enum recreation — the same explicitly-scoped exception
   pattern Phase 1 uses for `DROP NOT NULL`.
3. **Deploy guard, before step 2 runs anywhere:** assert in production that no
   `TenantBusinessProfile` row carries a removed value. Local says zero; the
   plan does not assume production matches. If a row exists, the migration
   must not run — update the row first, deliberately.
4. Every total map, the web union (generated by then — §4.8) and the registry
   simply lose two entries. The compiler walks the change through the
   codebase; that is what the total `Record`s are for.

**This also settles Q9** (whether `RETAIL` should keep its QuickBooks preset):
`RETAIL` no longer exists to have a preset. After Phase 0, **exactly one
business type in the system carries QuickBooks**, making §4.9's constraint a
checkable fact rather than a convention.

**And the pilot tenant is classified for real.** The PO has ruled the pilot
tile shop *is* a hardware-template business, so Phase 0 also writes it an
explicit `TenantBusinessProfile` row (`HARDWARE`, `QUICKBOOKS`/`QUICKBOOKS`) —
verified behaviour-preserving because HARDWARE's default module set is exactly
the legacy 13-module list. Mechanics and guards in §12.3.1. This closes the
"Legacy default" gap recorded in D55: the console can attribute the pilot to
the Hardware template because it now genuinely belongs to it.

### 4.9 QuickBooks is one domain's integration, not a core concern

**Stated constraint (PO, 2026-08-14): the QuickBooks integration applies to the
hardware/retail template only, and to no other template for the foreseeable
future.** That constraint is architecturally load-bearing and the current schema
contradicts it.

#### 4.9.1 Where QuickBooks currently lives

| Model | Vendor columns |
|---|---|
| `Product` | `quickbooksItemId`, `type` (QBO item type), `incomeAccount`, `purchaseDescription`, `expenseAccount`, `inventoryAssetAccount`, `quantityAsOfDate`, `lastSyncedAt`, `syncStatus` |
| `ProductCategory` | `quickbooksItemId` |
| `Customer` | `quickbooksCustomerId`, `lastSyncedAt`, `syncStatus` |
| `Supplier` | `quickbooksVendorId`, `qbStatus` |
| `Sale` | `quickbooksDocumentType`, `quickbooksDocumentId`, `syncStatus`, `syncError`, `@@index([syncStatus])` |
| `Payment` | `quickbooksPaymentId`, `syncStatus` |
| `Return` | `quickbooksDocumentType`, `quickbooksDocumentId`, `syncStatus` |
| `RefundPayment` | `quickbooksPaymentId`, `syncStatus` |

That is **eight Layer-1 models carrying one vendor's fields**. Worse, the
readers are not confined to the integration:

```
modules/categories/categories.repository.ts        ← reads quickbooksItemId
modules/customers/customers.repository.ts          ← reads syncStatus
modules/customers/customers.service.ts
modules/products/products.repository.ts            ← filters on syncStatus
modules/products/products.service.ts
modules/products/dto/query-products.dto.ts         ← syncStatus is a public query param
modules/products/products-report.service.ts
modules/sales/sales.service.ts / .repository.ts / .types.ts
modules/sales/dto/query-sales.dto.ts
modules/sales/sales-report.service.ts
```

Ten domain-neutral modules read vendor state. A restaurant tenant's product list
query still passes through `syncStatus` filtering; a hotel's sales report still
selects columns that will never be non-null for it.

#### 4.9.2 Why this matters more with N domains than with two

With two verticals it is untidy. With the domain-pack model it is a **liability
that grows linearly**: every new domain inherits nine dead columns on `Product`,
a `syncStatus` index on `Sale` it never populates, and a public API query
parameter (`syncStatus`) that is meaningless for it. And because the fields are
*present*, the cheapest thing for a future contributor to do is read them —
which is how `products.repository` came to filter on them in the first place.

It also violates this plan's own Layer-1 rule (§1.3) and D28's premise: the
accounting provider is supposed to be pluggable, and a pluggable provider whose
data lives in the core tables is not pluggable, it is merely wrapped.

#### 4.9.3 The mechanism already exists and is barely used

`QuickBooksMapping` (`schema.prisma:1064`) is already
`(tenantId, entityType, localId) → (quickbooksId, quickbooksType, lastSyncedAt)`
with both uniqueness directions — i.e. *already* the general external-reference
satellite. It has **two read sites in the entire codebase**
(`quickbooks-sales-sync.service.ts:281`, `quickbooks-returns-sync.service.ts:231`).
The vendor columns on the core tables are largely a **duplicate** of a table that
already exists for exactly this purpose.

#### 4.9.4 Target: `ExternalEntityRef`

Generalise `QuickBooksMapping` by one column and make it the single home for
every external identity:

```prisma
/// The one place a local entity's identity in an EXTERNAL system is recorded.
/// Generalises the existing QuickBooksMapping by adding `provider`, so a second
/// accounting integration (or a delivery platform, or a marketplace) needs no
/// new table and no columns on Layer-1 models.
///
/// Rule: no model outside a provider implementation may reference this table.
model ExternalEntityRef {
  id       String @id @default(cuid())
  tenantId String

  /// 'QUICKBOOKS' today. The value comes from the provider, never from a
  /// caller — a client cannot invent a provider namespace.
  provider   String
  /// 'PRODUCT' | 'PRODUCT_CATEGORY' | 'CUSTOMER' | 'SUPPLIER' | 'SALE' |
  /// 'PAYMENT' | 'RETURN' | 'REFUND_PAYMENT'
  entityType String
  /// The AxloPOS id. Loose by design — this table must not cascade-delete
  /// core rows, and a provider mapping outliving its entity is a
  /// reconciliation signal, not corruption.
  localId    String

  externalId   String
  externalType String?

  syncStatus   SyncStatus @default(NOT_SYNCED)
  syncError    String?
  lastSyncedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, provider, entityType, localId])
  @@unique([tenantId, provider, entityType, externalId])
  @@index([tenantId, provider, syncStatus])
}
```

**What this buys, concretely.** Domains 4..N get a `Product` table with no vendor
columns; `Sale` loses an index it never uses; `syncStatus` stops being a public
query parameter for tenants that have no sync; and a second accounting provider
— if one is ever wanted — is a provider implementation plus rows, not a
migration across eight core models.

**What it costs.** The QuickBooks sync path is the highest-risk code in the
system and it is the only thing a live paying tenant depends on. Every read
becomes a join or a batched lookup. This is why the quarantine is **Phase 6, not
Phase 1**, and why it is staged (§8.10) so that no step can break sync on its
own.

#### 4.9.5 The rule going forward

> **No Layer-1 model gains a vendor-named column.** External identity, sync
> state and sync errors live in `ExternalEntityRef`. Only a provider
> implementation may read it. Enforced by a contract test (§13.1).

And in the domain descriptor, QuickBooks-ness is declared **once**:

```ts
// hardware.domain.ts — the only descriptor that names QuickBooks
profile: { inventoryMode: 'QUICKBOOKS', accountingProvider: 'QUICKBOOKS' },
modules: [ …RETAIL_CORE_MODULES, ModuleKey.QUICKBOOKS ],
```

Every other descriptor declares `accountingProvider: 'NONE'` and omits the
module. A copy-pasted descriptor that leaves `QUICKBOOKS` in is caught by the
tripwire in §13.1 — which is the specific failure this section exists to
prevent.

#### 4.9.6 A live inconsistency this surfaced — resolved by §4.8.1

`BUSINESS_PROFILE_PRESETS` gave **`TILE_SHOP`, `HARDWARE` *and* `RETAIL`** the
`QUICKBOOKS`/`QUICKBOOKS` pair, while only `HARDWARE` was exposed as a template
— leaving `RETAIL` as an unused value that would silently arrive
QuickBooks-enabled if a future template ever reached for it. The PO resolved
this at the root: `HARDWARE` is the vertical's one canonical value, and
`TILE_SHOP` / `RETAIL` are removed (§4.8.1). After Phase 0, exactly one
business type in the system carries QuickBooks.

### 4.10 What stays closed, deliberately

Extensibility has a cost and not everything should pay it.

| Closed | Why |
|---|---|
| `SaleStatus`, `PaymentStatus`, `PaymentMethod` | financial state machines; a new value changes accounting semantics and must be a decision |
| `SellableKind` | inventory and pricing engines branch on it |
| `Permission` catalogue | D37: permissions are code, the DB stores only assignments |
| `ModuleKey` | drives route guards; a typo'd module key silently ungates a route |
| Money columns | `Decimal(12,2)`; never JSON, never per-domain |

The general rule: **anything that can silently change what a customer is charged,
or what a user may do, stays a typed, compile-checked value.**

---

## 5. The capability model

### 5.1 The problem it replaces

The predicate "is this a food-service tenant?" is written inline in **six page
bodies plus one resolver**:

```
apps/web/src/app/(app)/pos/page.tsx:49
apps/web/src/app/(app)/dashboard/page.tsx:39
apps/web/src/app/(app)/menu/page.tsx:44
apps/web/src/app/(app)/menu/items/new/page.tsx:61
apps/web/src/app/(app)/menu/items/[id]/edit/page.tsx:47
apps/web/src/components/pos/pos-counter-workspace.tsx:83
apps/web/src/lib/products/product-presentation.ts:60   (resolveBusinessKind)
```

each as a variant of `businessType === 'RESTAURANT' || 'CAFE' || 'BAKERY'`.
**Every one omits `HOTEL`** (§6). D31 forbids exactly this and is enforced for
the *product* screens; it was never extended to the page shells.

Adding `HOTEL` to seven files would leave the eighth to be forgotten, and vertical
#4 would rediscover the problem from scratch.

### 5.2 The shape

Capabilities are **declared per domain** (in the descriptor), not derived from a
`RESTAURANT | RETAIL` bucket. Bucketing is what breaks the moment a vertical is
"retail but with modifiers" — which GROCERY, above, already is.

```ts
export interface TenantCapabilities {
  catalogue: {
    variants: boolean;       // wizard + POS variant picker
    modifiers: boolean;      // modifier groups on products
    preparation: boolean;    // prepMinutes / dietaryTags / foodType
    collections: boolean;    // curated menus / assortments
    components: boolean;     // recipes / bill of materials
  };
  fulfilment: {
    kind: FulfilmentKind;
    stationRouting: boolean;
    rounds: boolean;
    channels: readonly OrderChannel[];
  };
  charges: {
    serviceCharge: boolean;
    packaging: boolean;
  };
  documents: {
    proformaBill: boolean;   // a bill issued before payment
    splitByItem: boolean;
  };
}
```

Composed from spreadable baselines — plain TypeScript, no DSL:

```ts
export const COMMERCE_BASELINE: TenantCapabilities = { /* everything off */ };

export const RETAIL_CAPABILITIES: TenantCapabilities = {
  ...COMMERCE_BASELINE,
  catalogue: { ...COMMERCE_BASELINE.catalogue, variants: true },
  fulfilment: { kind: 'IMMEDIATE', stationRouting: false, rounds: false, channels: ['COUNTER'] },
};

export const FOOD_SERVICE_CAPABILITIES: TenantCapabilities = {
  ...RETAIL_CAPABILITIES,
  catalogue: { variants: true, modifiers: true, preparation: true, collections: true, components: true },
  fulfilment: { kind: 'TABLE_SERVICE', stationRouting: true, rounds: true,
                channels: ['DINE_IN', 'TAKEAWAY', 'ONLINE'] },
  charges:   { serviceCharge: true, packaging: true },
  documents: { proformaBill: true, splitByItem: true },
};
```

### 5.3 Consumption rules (D31, generalised)

1. **No component, page or service compares `businessType`.** They read a
   capability, or they read the descriptor. A contract test asserts the business
   type string literals appear in exactly one file per workspace.
2. **Unresolved is its own state.** While the profile loads, capabilities are
   `null` and the UI renders no domain chrome — the existing D31 rule.
3. **Capabilities are affordances, never permission.** The server still refuses
   a table-service route for an `IMMEDIATE` tenant.
4. **Server-side too.** `computeDocumentTotals` takes `capabilities.charges`;
   the catalogue read model shapes its response from `capabilities.catalogue`.

---

## 6. Defects found during this review

Pre-existing, independent of whether the convergence proceeds. **None fixed** —
this document was requested as analysis only. Four of the seven are direct
consequences of the missing §4.

### D-1 — A HOTEL workspace gets the retail POS 🔴 **HIGH — FIXED in Phase 0**

`apps/web/src/app/(app)/pos/page.tsx:49-55`

```ts
const isRestaurantProfile =
  profile?.businessType === 'RESTAURANT' ||
  profile?.businessType === 'CAFE' ||
  profile?.businessType === 'BAKERY';

if (!isRestaurantProfile) return <PosRetailCheckout />;   // ← HOTEL lands here
```

A hotel workspace created through the D55 console gets the restaurant sidebar
(the nav map answers `HOTEL: RESTAURANT_NAV`) and the restaurant module set, but
tapping POS renders the **retail checkout** — for a tenant with no `RETAIL_POS`
module. A dead end.

**Correction to an earlier claim.** When D55 shipped I reported that a HOTEL
workspace "resolves to a module set byte-identical to RESTAURANT". That was and
is true — I verified the module set and the navigation. I did not verify the page
bodies, and the page bodies are where this breaks. The hotel template is correct
in the data and incomplete in the UI.

### D-2 — Same defect in the wizard, dashboard and menu pages 🔴 **HIGH — FIXED in Phase 0**

`resolveBusinessKind` (`product-presentation.ts:60`) omits `HOTEL`, so a hotel
tenant gets the **retail** product wizard: no Food/Beverage/Dessert selector, no
dietary tags, no prep time, no modifier or station step. Same for
`dashboard/page.tsx:39` and the three `menu/**` pages.

### D-3 — `NAV_BY_BUSINESS_TYPE` is not compile-checked 🟡 **MEDIUM — FIXED in Phase 0**

`web/nav.ts:274` declares `Record<string, NavGroup[]>` and `:321` reads
`NAV_BY_BUSINESS_TYPE[input.businessType] ?? RETAIL_NAV`. A new business type
silently gets the retail rail. HOTEL escaped only because the line was added by
hand. Likewise `roleTemplatesForBusinessType` takes a `string` and falls through
an `if` chain to the built-in roles.

The doc comment in `workspace-templates.ts` asserting that "each map is a total
`Record<BusinessType, …>`" is **true of four maps and false of the rest**, and
should be corrected regardless of whether this plan proceeds.

### D-4 — Restaurant sales have no line items 🔴 **CRITICAL**

`table-sessions.service.ts:751` and `takeaway.service.ts:258` both call
`tx.sale.create({ data: { …header only… } })`. No items are written. §3.2.

### D-5 — Restaurant orders never move stock 🔴 **CRITICAL**

`StockMovementReason.ORDER_ROUND` is declared at `schema.prisma:2378` and is
**never written by any code path** — the only `stockMovement.create` in the
repository is `local-inventory.provider.ts:241`, reached exclusively from
`sales.service.ts`. Neither `table-sessions` nor `takeaway` injects
`InventoryProviderFactory`.

`MenuItem.productId`'s own schema comment claims "sending an order round
decrements `Product.quantityOnHand` (LocalInventoryProvider) exactly as a retail
sale would". It does not. A food-service tenant's stock is purchase-side only:
receipts increase it, nothing decreases it.

Partly a genuine gap — depleting ingredients for a composed dish needs the
component model that does not exist (Phase 8). But for a **retail-shaped** item
in a restaurant — a bottled drink, a packaged snack — depletion is well-defined
today and simply is not happening.

### D-6 — `RestaurantOrderItem.menuItemId` is polymorphic 🟡 **MEDIUM**

`table-sessions.service.ts:571` writes `menuItemId: refId`, where `refId` is a
`MenuItem` id when `sourceKind = 'MENU_ITEM'` and a **`Product` id** when
`sourceKind = 'PRODUCT'`. `String` NOT NULL, indexed, no FK, and the name is now
false for half its rows. `kitchen.service.ts:90-125` already partitions by
`sourceKind` before every lookup. Understandable as a transition measure,
unacceptable as a resting state.

### D-7 — Three money calculators, two numeric regimes 🟡 **MEDIUM**

| Path | File | Arithmetic |
|---|---|---|
| Retail sale | `sales.service.ts:398-411` | JS `number` + `round2()` |
| Quotation | `quotations.calc.ts:87-100` | JS `number` + `round2()` |
| Restaurant bill | `restaurant/restaurant-totals.ts` | `Prisma.Decimal` |

The restaurant calculator (D52) is correct and property-tested. The other two
compute money in binary floating point and round at each step. They agree today
for the tenants in play; that is luck.

### D-8 — `Sale` cannot say which channel it was 🟡 **MEDIUM**

`Sale` has `serviceChargeAmount` and `packagingCharge` but no `channel`.
Channel lives only on `RestaurantOrder`, so a settled takeaway is
indistinguishable from a settled dine-in at the `Sale` level.

### D-9 — Domain-neutral modules read QuickBooks columns 🟡 **MEDIUM**

Ten modules that serve every domain read vendor state: `categories`,
`customers` (×2), `products` (×3 including the public `QueryProductsDto`),
`products-report`, `sales` (×4 including `QuerySalesDto`), `sales-report`.

Two consequences beyond untidiness:

1. `syncStatus` is a **public API query parameter** on `/products` and `/sales`
   for every tenant, including those with `accountingProvider: NONE` where it is
   permanently `NOT_SYNCED`.
2. `Sale` carries `@@index([syncStatus])`, maintained on every insert for every
   tenant, and useful to one.

Given the PO's constraint that QuickBooks serves the hardware template only,
this coupling now scales with the number of domains rather than staying
constant. §4.9 and §8.10.

### D-10 — `RETAIL` is preset to QuickBooks with no template behind it 🟢 **LOW — FIXED in Phase 0 (values removed)**

`BUSINESS_PROFILE_PRESETS` gives `RETAIL` the `QUICKBOOKS`/`QUICKBOOKS` pair.
No workspace template exposes `RETAIL`, so nothing creates such a tenant today —
but the preset was a loaded gun for the first future template that reused the
value. **Resolved by the PO's consolidation decision (§4.8.1): `RETAIL` and
`TILE_SHOP` are removed outright; `HARDWARE` is the vertical's one value.**
Lands in Phase 0.

---

## 7. Design principles

**P1. One authority per fact.** A sellable item's name, price, image and
modifiers live in exactly one table.

**P2. Snapshots are for history, not duplication.** Freezing `productName` and
`unitPrice` onto a dated document is correct. Storing the same name on two
*catalogue* rows is not.

**P3. Additive migrations only** until a backfill is verified in production.
Every phase is `add → dual-write → backfill → verify → switch reads → (later)
drop`. No phase needs a drop to deliver value.

**P4. Variation is resolved once and passed down.** D28/D31 generalised: a
resolver per axis, and the result is a value object.

**P5. The server is the authority; capabilities are affordances.**

**P6. A new domain must not require editing an existing one.** The test of every
design choice in §4.

---

## 8. Target database design

| # | Change | Type | Phase |
|---|---|---|---|
| 8.1 | `SaleItem` accepts any domain's lines | additive + `DROP NOT NULL` | 1 |
| 8.2 | `Sale` gains `channel`, `fulfilmentKind`, `sourceRef`, `servedByUserId` | additive | 1 |
| 8.3 | `Product.sellableKind` (QBO columns quarantined separately — 8.10) | additive | 3 |
| 8.4 | `Product.attributes` + per-domain schema | additive | 7 |
| 8.5 | `MenuItem` → `CatalogueEntry` (thin placement) | additive + backfill | 3 |
| 8.6 | Station links collapse to `ProductStationLink` | backfill + deferred drop | 3 |
| 8.7 | One charge-configuration model | additive | 2 |
| 8.8 | `ProductComponent` — recipes / BoM | additive | 8 |
| 8.9 | `RestaurantOrderItem.menuItemId` retired | deferred drop | 3 |
| 8.10 | **QuickBooks quarantine** — `ExternalEntityRef` | additive + deferred drop | 6 |

### 8.1 `SaleItem` — the universal transaction line

`SaleItem` cannot represent a non-retail line today: `productId` is `NOT NULL`,
there is nowhere for modifiers, and nowhere to say which operational record it
came from.

```prisma
model SaleItem {
  id     String @id @default(cuid())
  saleId String

  /// CHANGED → nullable. Null when the line came from a legacy MenuItem with
  /// no linked Product, or from an open/one-off item. `productName` is always
  /// populated, so a null here never costs the document its meaning.
  productId        String?
  productVariantId String?

  productName         String
  sku                 String?
  variantSkuSnapshot  String?
  variantNameSnapshot String?
  unitPrice           Decimal @db.Decimal(12, 2)
  quantity            Decimal @db.Decimal(12, 3)

  /// NEW. Which fulfilment lifecycle produced this line. Total over the enum,
  /// so a new FulfilmentProvider must answer here.
  sourceKind   SaleItemSourceKind @default(RETAIL_CART)
  /// NEW. The operational row projected from. Loose by design — the
  /// operational row may be archived independently — but UNLIKE the current
  /// `menuItemId` it is typed by `sourceKind` and never reused for another
  /// entity.
  sourceItemId String?
  /// NEW. Modifier deltas frozen onto the line, so bill maths never needs the
  /// child rows.
  modifierTotal Decimal @default(0) @db.Decimal(12, 2)
  /// NEW. The note that reached the preparer — it can change what was
  /// actually delivered ("no nuts").
  notes         String?

  discountId       String?
  discountType     DiscountType?
  discountValue    Decimal? @db.Decimal(12, 2)
  discountAmount   Decimal  @default(0) @db.Decimal(12, 2)
  discountReason   String?
  approvedByUserId String?
  taxAmount        Decimal  @default(0) @db.Decimal(12, 2)
  lineSubtotal     Decimal  @db.Decimal(12, 2)
  lineTotal        Decimal  @db.Decimal(12, 2)
  returnedQuantity Decimal  @default(0) @db.Decimal(12, 3)
  returnStatus     SaleReturnStatus @default(NOT_RETURNED)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  sale           Sale               @relation(fields: [saleId], references: [id], onDelete: Cascade)
  product        Product?           @relation(fields: [productId], references: [id])
  productVariant ProductVariant?    @relation(fields: [productVariantId], references: [id])
  discount       Discount?          @relation(fields: [discountId], references: [id])
  approvedBy     User?              @relation("DiscountApprover", fields: [approvedByUserId], references: [id])
  returnItems    ReturnItem[]
  modifiers      SaleItemModifier[]

  @@index([saleId])
  @@index([productId])
  @@index([productVariantId])
  @@index([sourceKind, sourceItemId])
}

/// NEW. Frozen modifier selections on a settled line. Mirrors
/// RestaurantOrderItemModifier field-for-field so the projection at close is a
/// copy with no interpretation.
model SaleItemModifier {
  id         String @id @default(cuid())
  tenantId   String
  saleItemId String

  modifierOptionId String?
  optionName       String
  groupName        String
  priceDelta       Decimal @default(0) @db.Decimal(12, 2)

  createdAt DateTime @default(now())

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  saleItem SaleItem @relation(fields: [saleItemId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([saleItemId])
}

/// Extend, never repurpose. A new fulfilment kind adds a value here.
enum SaleItemSourceKind {
  RETAIL_CART
  RESTAURANT_ORDER_ITEM
}
```

**Migration note.** `DROP NOT NULL` widens and is safe, but it *is* an `ALTER`,
and `provider-contract.spec.ts` currently asserts additive-only. The proof must
be extended to permit `DROP NOT NULL` while continuing to forbid `SET NOT NULL`.
That asymmetry is the correct rule and belongs in the decision record.

**Backfill.** `TableSession.finalSaleId` links each closed session to its sale
and the order items are all still present, so historical `SaleItem` rows are
reconstructible. Write it, dry-run it, and run it as an **explicit operational
step** — reconstructing financial history is not something `migrate deploy`
should do silently. See open question Q1.

### 8.2 `Sale` — say what kind of sale it was

```prisma
model Sale {
  // … existing …

  /// NEW. Which lifecycle settled this sale. Domain-neutral.
  fulfilmentKind FulfilmentKind @default(IMMEDIATE)
  /// NEW. Sales channel. COUNTER for immediate; the food-service values keep
  /// their existing names so no data changes meaning.
  channel        OrderChannel   @default(COUNTER)
  /// NEW. Typed reference to the operational work unit this settled, when
  /// there was one. `{kind, id}` semantics; null for a counter sale.
  sourceRefKind  String?
  sourceRefId    String?
  /// NEW. Who served, as distinct from who took the money (open question Q6).
  servedByUserId String?

  @@index([channel])
  @@index([tenantId, completedAt])
}

enum FulfilmentKind { IMMEDIATE  TABLE_SERVICE }   // extended per domain

/// Supersedes RestaurantOrderChannel; its three values are a strict subset,
/// so the backfill is a straight cast.
enum OrderChannel { COUNTER  DINE_IN  TAKEAWAY  ONLINE }
```

### 8.3 `Product.sellableKind` — AxloPOS's own vocabulary

`Product.type` is a QuickBooks string (`"Inventory" | "NonInventory" |
"Service"`) doing double duty as a domain discriminator —
`sales.service.ts:383` derives `trackInventory: product.type === 'Inventory'`
from it. A vendor's vocabulary in the core domain, with no value meaning "a dish
assembled from ingredients", let alone "a room-night".

```prisma
model Product {
  /// NEW. Defaulted to STOCK_ITEM so every existing row is valid unchanged.
  /// Backfill maps `type` ("Service" → SERVICE, else STOCK_ITEM); D45
  /// restaurant products carrying a `foodType` become COMPOSED_ITEM.
  sellableKind SellableKind @default(STOCK_ITEM)

  /// KEPT, and now clearly distinct: `foodType` is a PRESENTATION tag driving
  /// POS grid grouping. `sellableKind` drives INVENTORY behaviour. A bottled
  /// beer is STOCK_ITEM + BEVERAGE.
  foodType MenuItemType?
}
```

**QuickBooks columns — recommendation revised (§4.9).** `Product` carries seven
QBO fields plus two sync columns. An earlier draft of this plan recommended
leaving them in place indefinitely, on the grounds that they are nullable and
harmless.

**That is no longer the recommendation.** Under the PO constraint that
QuickBooks serves the hardware template only, "nullable and harmless" is true of
the *columns* and false of the *coupling*: ten domain-neutral modules read them
(D-9), `syncStatus` is a public query parameter for every tenant, and every
future domain inherits all of it. The cost is now proportional to the number of
domains, which is the number this plan exists to grow.

**Recommended: quarantine into `ExternalEntityRef` (§8.10), scheduled as Phase
6** — after the settlement, money and catalogue work, because the QuickBooks
sync path is the highest-risk code in the system and the only thing a live
paying tenant depends on. Staged so no single step can break sync.

### 8.4 `Product.attributes` — §4.6. Phase 7.

### 8.5 Retiring `MenuItem` — the placement model

`MenuItem` owns `name`, `description`, `basePrice`, `imageUrl`, `prepMinutes`,
`itemType`, `dietaryTags`, `productId`, `productVariantId`, plus child
`modifierGroups`, `channelPrices`, `availability`, `stationLinks`. Every scalar
now also exists on `Product`.

The target splits it into what it actually is — **a placement of a product in a
collection** — and moves everything else to `Product`.

```prisma
/// Kept as table `Menu` to avoid a rename migration; the API calls it a
/// collection, because retail wants one too ("Trade counter", "Seasonal").
model Menu {
  // unchanged: id, tenantId, branchId, name, description, isActive, version
  /// NEW. Which channels this collection applies to. Empty = all.
  channels OrderChannel[] @default([])
}

/// REPLACES the fat MenuItem. Thin: which product appears where, in what
/// order, optionally at what price.
model CatalogueEntry {
  id        String @id @default(cuid())
  tenantId  String
  sectionId String

  /// NOT NULL — an entry with no product is exactly the duplication being
  /// removed.
  productId        String
  productVariantId String?

  /// The ONLY price a placement may own, and it is an override, not a second
  /// authority (P1). Null = the product's price applies.
  priceOverride Decimal? @db.Decimal(12, 2)

  position Int     @default(0)
  isActive Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant         Tenant                  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  section        MenuSection             @relation(fields: [sectionId], references: [id], onDelete: Cascade)
  product        Product                 @relation(fields: [productId], references: [id], onDelete: Cascade)
  productVariant ProductVariant?         @relation(fields: [productVariantId], references: [id])
  availability   CatalogueAvailability[]
  channelPrices  CatalogueChannelPrice[]

  @@unique([sectionId, productId, productVariantId])
  @@index([tenantId])
  @@index([productId])
}
```

| `MenuItem` field | Destination |
|---|---|
| `name`, `description`, `imageUrl` | `Product` — already there |
| `basePrice` | `Product.unitPrice` / `ProductVariant.unitPrice`; `CatalogueEntry.priceOverride` for placement pricing |
| `prepMinutes`, `itemType`, `dietaryTags` | `Product` — already there (D45) |
| `productId`, `productVariantId` | `CatalogueEntry`, now required |
| `modifierGroups` | `ProductModifierGroup` — junction exists |
| `stationLinks` | `ProductStationLink` — junction exists |
| `channelPrices` | `CatalogueChannelPrice` |
| `availability` | `CatalogueAvailability` |

**Backfill.** For each `MenuItem`: if `productId` is set, create a
`CatalogueEntry`, copy `basePrice` to `priceOverride` *only if* it differs from
the product's price, and copy modifier/station links to the `Product*` junctions
if absent. If `productId` is null, **create a `Product`** (`sellableKind =
COMPOSED_ITEM`, `foodType = itemType`, scalars copied), then the entry. Record
the new id on `MenuItem.migratedProductId` for auditability. See Q2.

### 8.6 Station routing

After 8.5 every order line is product-sourced, so `MenuItemStationLink` has no
readers and `kitchen.service.ts:90-145`'s two-branch lookup collapses to one
query.

**Optional generalisation:** `KitchenStation` is a *fulfilment station* — the
concept applies to a key-cutting bench, a glass-cutting table, a bike workshop.
Renaming to `FulfilmentStation` is a genuine generalisation with a plausible
future customer. **Recommended: defer** — a rename touching 6 models and ~600
lines of kitchen code for a use case nobody has asked for. Note it; do not build
it. (If `WORK_ORDER` fulfilment ever ships, do it then.)

### 8.7 One charge configuration, one calculator

| Fact | Where today | Shape |
|---|---|---|
| `taxRatePercent` | `TenantSettings.data` (JSON) | tenant-wide, untyped |
| `serviceChargePercent`, `serviceChargeChannels`, `serviceChargeTaxable`, `packagingChargeAmount` | `RestaurantBranchConfig` | per-branch, typed |

So tax is tenant-wide and untyped; service charge is per-branch and typed. A
retail tenant cannot set a service charge; a restaurant cannot set a per-branch
tax rate; a future hotel can set neither a city tax nor a resort fee.

**Proposal — one typed, per-branch charge model with tenant fallback**, and
renamed in the API (table name kept to avoid a rename migration):

```prisma
model RestaurantBranchConfig {   // API name: branch charge configuration
  // … existing …

  /// NEW. Per-branch tax rate. NULL = inherit the tenant-wide default.
  /// Nullable rather than defaulted to 0, because 0 is a meaningful rate and
  /// must be distinguishable from "unset".
  taxRatePercent Decimal? @db.Decimal(5, 2)
}
```

and one calculator used by retail, food service **and** quotations:

```ts
export function computeDocumentTotals(
  lines: readonly LineInput[],
  channel: OrderChannel,
  config: ChargeConfig,
  orderDiscount?: OrderDiscountInput,
): DocumentTotals;
```

`restaurant-totals.ts` is already 90% of this and carries the property test
("parts always sum to total"). The work is widening it for line and order
discounts, then deleting the arithmetic in `sales.service.ts:398-411` and
`quotations.calc.ts:87-100`.

**Non-negotiable:** `Prisma.Decimal` throughout. Existing retail behavioural
assertions must not be edited to accommodate the change (D16) — if a retail total
shifts by a cent, that is a bug being found and it needs a decision record, not a
test edit.

### 8.8 `ProductComponent` — recipes (Phase 8)

Required to close D-5 for `COMPOSED_ITEM`. Deliberately minimal.

```prisma
/// What a COMPOSED_ITEM consumes per unit sold. Absent = depletes 1:1.
model ProductComponent {
  id       String @id @default(cuid())
  tenantId String

  productId        String
  productVariantId String?

  componentProductId String
  componentVariantId String?

  quantity    Decimal  @db.Decimal(12, 4)
  unit        String?
  /// Proportional loss (trim, evaporation). 0.05 = 5%.
  wastageRate Decimal  @default(0) @db.Decimal(5, 4)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant           Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  product          Product @relation("AssembledProduct", fields: [productId], references: [id], onDelete: Cascade)
  componentProduct Product @relation("ComponentProduct", fields: [componentProductId], references: [id])

  @@unique([productId, productVariantId, componentProductId, componentVariantId])
  @@index([tenantId])
  @@index([componentProductId])
}
```

Depletion: expand each line one level through its components and call the
existing `InventoryProvider.reduceStock`. `StockMovementReason.ORDER_ROUND`
finally gets a writer.

**Explicitly out of scope:** recursive nesting, yield management, par levels,
theoretical-vs-actual variance. One level, no recursion — stated in the schema
comment so nobody assumes otherwise.

### 8.9 Retiring `RestaurantOrderItem.menuItemId`

`productId` and `productVariantId` already exist. Backfill `productId` for
`MENU_ITEM` rows from `MenuItem.migratedProductId`; switch `kitchen`, `billing`
and `restaurant-reports` to `productId`; keep `menuItemId` populated but unread
for one release; drop it and `sourceKind` in a later, separate migration.

### 8.10 QuickBooks quarantine — the staged plan (Phase 6)

The target is §4.9.4's `ExternalEntityRef`. Sequenced so that **every step is
individually revertible and no step changes sync behaviour on its own.**

| Step | Action | Reversible by |
|---|---|---|
| 1 | Add `ExternalEntityRef`; add `provider` to `QuickBooksMapping` rows via backfill, or migrate them into the new table wholesale | dropping the new table |
| 2 | **Dual-write.** Every place that writes a QBO column also writes `ExternalEntityRef`. No reads change | disabling the second write |
| 3 | Backfill from the existing columns for every tenant with a `QuickBooksConnection`; reconcile row counts per entity type and fail loudly on mismatch | truncating the new table |
| 4 | **Verify in production.** A read-only reconciliation job asserts column and satellite agree for a full sync cycle | n/a — observation only |
| 5 | Switch the QuickBooks provider and sync services to read the satellite. Core modules stop reading vendor columns entirely | reverting the read switch; columns still populated |
| 6 | Remove `syncStatus` from `QueryProductsDto` / `QuerySalesDto`, or gate it behind the QUICKBOOKS module (Q10) | restoring the DTO field |
| 7 | **Stop writing** the columns; they go stale but stay | resuming the dual-write |
| 8 | Separate, much later migration: drop the columns and `Sale.@@index([syncStatus])` | — (point of no return; own decision record) |

Steps 1–5 are Phase 6. Steps 6–7 follow one release later. **Step 8 is not part
of this plan** and needs its own decision record, like every other drop here.

**Non-goal.** This does not build a second accounting provider, and it does not
change any QuickBooks behaviour a hardware tenant can observe. It moves where
the integration's data lives so that domains 4..N do not inherit it.

**Order of entity types.** Do the low-traffic, low-risk mappings first —
`ProductCategory`, `Supplier`, `Customer` — and `Sale` / `Payment` / `Return` /
`RefundPayment` last, since those are the rows a tenant's accountant reconciles.

---

## 9. Target REST API design

### 9.1 Principles

- **Stable paths stay.** `/products` is the canonical catalogue root for every
  domain. Do **not** rename it to `/catalogue` — 263 routes are enumerated in a
  tripwire and a doc, clients exist, and the rename buys nothing a label cannot.
- **Domain-neutral concepts move out of `/restaurant`.** Modifier groups and
  menus are not restaurant concepts.
- **Domain-specific fulfilment keeps its own namespace.** `/restaurant/*` for
  table service, `/appointments/*` for a future salon. A domain owns its
  lifecycle routes and nothing else.
- **One POS read model**, parameterised by channel and shaped by capabilities.
- **Envelope unchanged:** `{ "data": … }`.
- **Deprecation policy:** aliased routes return `Deprecation` and `Sunset`
  headers, log the caller's user agent once, and are removed no earlier than two
  releases later.

### 9.2 Route changes

#### Catalogue — canonical, domain-neutral

| Method | Path | Change |
|---|---|---|
| GET | `/products` | gains `sellableKind`, `channel`, `attributes.*` filters |
| POST · PATCH · DELETE | `/products`, `/products/:id` | body gains `sellableKind`, `attributes` |
| **GET** | **`/products/sellable`** | **new** — unified POS read model (§9.3) |
| GET·POST | `/products/modifier-groups` | **moved** from `/restaurant/modifier-groups`; alias kept |
| GET·PATCH | `/products/modifier-groups/:groupId` | **moved**; alias kept |
| GET·PUT | `/products/:id/components` | **new** — Phase 8 |
| GET | `/products/attribute-schema` | **new** — the tenant's domain attribute fields, so the wizard is generic |

#### Collections — generalised menus

| Method | Path | Replaces |
|---|---|---|
| GET·POST | `/branches/:branchId/collections` | `…/restaurant/branches/:branchId/menus` |
| PATCH | `/collections/:collectionId` | `…/menus/:menuId` |
| GET·POST | `/collections/:collectionId/sections` | `/restaurant/menus/:menuId/sections` |
| PATCH | `/sections/:sectionId` | `…/sections/:sectionId` |
| GET·POST | `/sections/:sectionId/entries` | `/restaurant/menu-sections/:sectionId/items` |
| PATCH·DELETE | `/entries/:entryId` | `…/items/:itemId` (D42/D43 archive semantics preserved) |

#### Platform — domain metadata

| Method | Path | Change |
|---|---|---|
| GET | `/platform/profile` | **gains `capabilities` and `domain`** — the client stops deriving them |
| GET | `/platform-admin/templates` | now **derived** from `DOMAIN_REGISTRY`, not a hand-written array |

#### QuickBooks — unchanged paths, tightened scope

The nine `/quickbooks/*` and `/sync/*` routes already carry
`@RequireModule(QUICKBOOKS)` and are `ENFORCED` in the route matrix, so a
non-hardware tenant is already refused at the guard. Nothing there changes.

What changes is that **vendor fields stop appearing in domain-neutral
responses and requests**:

| Surface | Today | After Phase 6 |
|---|---|---|
| `GET /products` response | always carries `quickbooksItemId`, `syncStatus`, `lastSyncedAt` | present only when the tenant's accounting provider is QuickBooks (§9.5 nullability rule: **absent**, not null) |
| `GET /products?syncStatus=…` | accepted for every tenant | rejected `400` unless the QUICKBOOKS module is enabled (Q10) |
| `GET /sales` response | always carries `quickbooksDocumentId`, `syncStatus` | same rule |
| `POST /products/:id/sync-to-quickbooks` | unchanged | unchanged |

This is the §9.5 rule doing real work: a restaurant tenant's product payload
should not contain a key whose only possible value is `"NOT_SYNCED"`, because a
future reader will inevitably build a feature on it.

#### Sales — unchanged paths, widened responses

| Method | Path | Change |
|---|---|---|
| GET | `/sales`, `/sales/:id` | gain `channel`, `fulfilmentKind`; `items[]` now populated for every domain, each with `modifiers[]`, `notes`, `sourceKind` |
| GET | `/sales/report` | gains `channel`, `fulfilmentKind`, `groupBy` |

#### Reporting — collapse the parallel stack

The six `/restaurant/reports/*` routes exist because `SaleItem` was empty.

| Restaurant route | Backed by, after Phase 1 |
|---|---|
| `…/sales-summary` | shared sales query, `branchId` + range |
| `…/top-items` | shared item query over `SaleItem` |
| `…/payment-breakdown` | shared query, `groupBy=paymentMethod` |
| `…/channels` | shared query, `groupBy=channel` |
| `…/waiter-performance` | shared query, `groupBy=servedBy` |
| `…/voids` | **keep as-is** — an order-lifecycle fact with no sale-level analogue |

**Recommended: keep all six endpoints and re-implement them over the shared
query layer.** The win is one query implementation, not one endpoint; the
domain-appropriate names and shapes are worth keeping, and a future domain will
want its own three or four in the same style.

### 9.3 `GET /products/sellable` — the unified POS read model

Replaces `GET /restaurant/pos-catalogue` outright and `GET /products/search` for
POS use. **Its response shape is decided by capabilities, so a new domain gets a
working POS grid without a new endpoint.**

```
GET /v1/products/sellable
  ?branchId=brn_123        (required — availability and stock are per branch)
  &channel=DINE_IN         (optional; defaults to the domain's primary channel)
  &collectionId=col_1      (optional — restrict to one curated collection)
  &categoryId=cat_9
  &sellableKind=STOCK_ITEM
  &foodType=FOOD           (ignored unless capabilities.catalogue.preparation)
  &attr.viewType=Sea       (domain attribute filter — validated against the schema)
  &search=burg
  &cursor=…&limit=100
```

```jsonc
{
  "data": {
    "items": [{
      "id": "prd_1",
      "name": "Classic Burger",
      "description": "180g patty, brioche bun",
      "imageUrl": "https://…",
      "sellableKind": "COMPOSED_ITEM",
      "unitPrice": "1450.00",        // decimal STRING, never a JS float
      "effectivePrice": "1600.00",   // after collection / channel / promotion
      "priceSource": "CHANNEL_OVERRIDE",
      "category": { "id": "cat_9", "name": "Mains" },
      "subcategory": null,
      "attributes": { "spiceLevel": "Medium" },

      // present only when capabilities.catalogue.preparation
      "prepMinutes": 12,
      "dietaryTags": ["Non-Veg", "Spicy"],
      "foodType": "FOOD",

      // present only when capabilities.catalogue.variants
      "hasVariants": true,
      "variants": [{ "id": "var_1", "sku": "BRG-S", "name": "Single",
                     "unitPrice": "1450.00", "isDefault": true, "isActive": true }],

      // present only when capabilities.catalogue.modifiers
      "modifierGroups": [{ "id": "mg_1", "name": "Add extras", "selection": "MULTIPLE",
        "minSelections": 0, "maxSelections": 3, "role": null,
        "options": [{ "id": "mo_1", "name": "Bacon", "priceDelta": "200.00", "isActive": true }] }],

      // present only when capabilities.fulfilment.stationRouting
      "stations": [{ "id": "kst_1", "code": "GRILL", "name": "Grill", "category": "HOT" }],

      "promotions": [{ "id": "pro_1", "name": "Lunch combo",
                       "type": "BUNDLE_FIXED_PRICE", "description": null }],

      // present only when the tenant tracks stock
      "availableQuantity": "42.000",
      "stockState": "IN_STOCK"        // IN_STOCK | LOW | OUT | UNTRACKED
    }],
    "total": 137,
    "nextCursor": "eyJpZCI6…"
  }
}
```

**Design notes.**

- **Capability-shaped, not domain-shaped.** A retail tenant gets **no**
  `modifierGroups` key — not an empty array, which would be indistinguishable
  from "has none configured" (§9.5).
- **`effectivePrice` + `priceSource`.** Price resolution (base → variant →
  collection override → channel override → promotion) happens server-side and
  once, and the response says which rule won. The client currently re-derives
  parts of this.
- **Constant query count.** `pos-catalogue.service.ts` already fetches every
  dependent shape in one `include`; keep that and add a test asserting the query
  count does not grow with the number of products returned.
- **`stockState`, not booleans.** `UNTRACKED` is a real state (`SERVICE`
  products, `DISABLED` inventory) and must not collapse into `OUT`.

### 9.4 Order intake — one line shape, N entry points

The **payload** converges even though the endpoints do not — which is what lets a
new domain reuse every client-side cart and dialog:

```jsonc
{
  "productId": "prd_1",
  "productVariantId": "var_1",
  "quantity": "2.000",
  "modifiers": [{ "modifierOptionId": "mo_1" }],
  "notes": "no onions",
  "discount": { "type": "PERCENTAGE", "value": "10.00", "reason": "…" }
}
```

`sourceKind` disappears from the **request** entirely — the client no longer
tells the server which of two catalogues it read from, because there is one. It
survives only as a historical column (§8.9).

### 9.5 Cross-cutting conventions to fix while here

| Issue | Current | Proposed |
|---|---|---|
| Money in JSON | mixed — `pos-catalogue` emits `number`, sales emit strings | **always a decimal string**; a `number` cannot hold `0.1 + 0.2` and the client re-parses anyway |
| Pagination | `page`/`pageSize` on some routes, unbounded on others | keyset `cursor`/`limit`, capped at 200 server-side |
| Errors | `{code, message}` on newer routes, bare message on older | `{code, message, details?}` everywhere; clients match on `code` only — already the rule at `login/page.tsx:71` |
| Branch scoping | path param, query param, or inferred from the token | path param when the resource belongs to a branch; the token's `activeBranchId` never silently substituted |
| Nullability | `[]` vs absent used interchangeably | **absent = "this domain does not have this concept"; `[]` = "has it, none configured"** |

That last row is what makes capability-shaped responses legible.

### 9.6 Versioning

Everything stays under `/v1`. Nothing above is breaking **except** money-as-
string and the `/restaurant/pos-catalogue` retirement, each with exactly one
first-party consumer. Ship them with the client in one release rather than
inventing `/v2`.

---

## 10. Frontend consequences

| Change | Files | Effort |
|---|---|---|
| Domain descriptor consumption + capability context | `lib/domain.ts` (new), `lib/platform-profile.tsx` | 2 d |
| Nav reads `domainFor(t).navigation` + icon-name map | `lib/nav.ts`, `lib/nav-icons.ts` (new) | 1 d |
| Delete the 7 inline predicates | the sites in §5.1 | 1 d |
| One catalogue client | merge `lib/restaurant/pos-catalogue-api.ts` into `lib/products-api.ts` | 2 d |
| One cart | merge `lib/cart.ts` and `lib/pos-cart.tsx` behind one interface | 3 d |
| POS shells share catalogue + cart panes | `pos-*-workspace.tsx`, `pos-retail-checkout.tsx` | 5 d |
| Generic attribute step in the wizard | `components/products/wizard/**` | 3 d |
| Delete menu admin | `components/restaurant/menu/**` | −1,500 lines |

The POS workspaces should **not** merge into one component. They differ in
fulfilment, which is the axis that genuinely differs. They should share the
catalogue grid, the cart panel, the modifier dialog and the payment dialog —
most of their pixel area — so that a future domain's workspace is a fulfilment
pane plus three shared panes.

---

## 11. Phased plan

### Phase 0 — domain packs and capabilities *(no schema change; 5–8 d)*

1. `packages/shared/src/domains/**` — `DomainDescriptor`, `DOMAIN_REGISTRY`
   (total, no fallback), four descriptors.
2. Move modules, nav, role templates, presets, labels and template copy into the
   descriptors; delete the seven scattered maps.
3. `NavIconName` + `NAV_ICONS` on the web side.
4. `TenantCapabilities` declared per descriptor; returned on
   `GET /platform/profile`.
5. Delete `resolveBusinessKind` and the six inline predicates.
6. Generate the web `BusinessType` union from the Prisma enum.
7. **Business-type consolidation (§4.8.1):** repoint `LEGACY_TENANT_DEFAULTS`
   and the repository fallback from `TILE_SHOP` to `HARDWARE`; write the pilot
   tenant its explicit `HARDWARE` profile row with the before/after profile
   diff guard (§12.3.1); then **remove** `TILE_SHOP` and `RETAIL` from the
   enum via a type-recreation migration with its own decision record, after
   the deploy guard proves no production profile row carries either value.
8. Contract test: business-type literals appear in exactly one file per
   workspace.

**Exit criteria:** a HOTEL workspace reaches the restaurant POS, dashboard and
product wizard — verified in a browser, not only in tests. Adding a fictional
`DEMO` domain in a scratch branch requires one file and one line.

### Phase 1 — universal settlement document *(additive + operational backfill; 5–8 d)*

1. Migration: `SaleItem.productId` nullable; `sourceKind`, `sourceItemId`,
   `modifierTotal`, `notes`; `SaleItemModifier`; `Sale.channel`,
   `fulfilmentKind`, `sourceRefKind`, `sourceRefId`, `servedByUserId`; enums.
2. Projection in `closeSession` and the takeaway close, inside the existing
   transaction.
3. **In-transaction assertion** that `Σ lineTotal == Sale.subtotal`; fail the
   close rather than persist an inconsistent document.
4. `billing.service` reads `SaleItem` for a **settled** bill; keeps
   `RestaurantOrderItem` for the pre-settlement running bill.
5. Historical backfills per §12.3.2 — fulfilment facts on existing
   restaurant `Sale` headers, then line reconstruction — dry-run report +
   sign-off (Q1).
6. Enable restaurant returns through the shared `ReturnsService`, or defer with
   a recorded reason.

**Rollback:** columns are additive, the projection is write-only — disabling
step 2 leaves the system exactly as today.

### Phase 2 — one money engine *(additive; 3–5 d)*

Widen `restaurant-totals.ts` into `computeDocumentTotals`; repoint
`sales.service` and `quotations.calc`; convert both to `Prisma.Decimal`; add the
per-branch tax override with tenant fallback. **Do not edit existing retail
assertions** (D16). Differential test first (§13.3).

### Phase 3 — catalogue convergence *(additive + backfill; 8–12 d)*

`Product.sellableKind`, `CatalogueEntry`, `CatalogueAvailability`,
`CatalogueChannelPrice`, `MenuItem.migratedProductId`; the backfill with a
dry-run report; switch `pos-catalogue` / `kitchen` / `billing` reads to
`Product`; `POST`/`PATCH` on `/restaurant/menu-items` → `410 Gone`; delete
`components/restaurant/menu/**`. Leave the old tables in place, unread.

### Phase 4 — `FulfilmentProvider` *(no schema change; 5–8 d)*

Extract the interface; implement `ImmediateFulfilmentProvider` and
`TableServiceFulfilmentProvider` over the existing services; route settlement
through `collectSettlementLines` + `releaseResources`. **This is the phase that
makes domain #4 cheap** — do not skip it because Phases 0–3 already "work".

### Phase 5 — API surface *(no schema change; 4–6 d)*

`/products/sellable`; move the modifier routes; add collection routes; add
`capabilities` and `domain` to `/platform/profile`; derive
`/platform-admin/templates` from the registry; deprecation headers; update
`route-module-matrix.spec.ts` and the matrix doc; migrate the two web clients.

### Phase 6 — QuickBooks quarantine *(additive + deferred drop; 6–10 d)*

Steps 1–5 of §8.10: `ExternalEntityRef`, dual-write, backfill, production
reconciliation, read switch. Then the ten domain-neutral modules stop reading
vendor columns, and the `/products` and `/sales` payloads stop carrying them for
tenants without the QUICKBOOKS module.

**Why here and not earlier.** The QuickBooks path is the only thing a live
paying tenant depends on, and this phase has no user-visible benefit — its
entire value is that domains 4..N do not inherit the coupling. Doing it before
Phases 1–3 would spend the risk budget on the lowest-visibility work. Doing it
*after* Phase 5 means the catalogue and settlement work is already stable
underneath it.

**Do not skip it because it is invisible.** The same warning as Phase 4 (R9):
every domain added before this lands inherits nine dead columns and a public
query parameter that means nothing to it.

### Phase 7 — catalogue attribute extension *(additive; 5–8 d)*

`Product.attributes` + GIN index; `attributeSchema` in descriptors;
`GET /products/attribute-schema`; generic wizard step; server-side validation;
`attr.*` filters on `/products/sellable`.

### Phase 8 — components and depletion *(additive; 8–15 d)*

`ProductComponent`; wizard recipe step; one-level expansion at depletion;
`StockMovementReason.ORDER_ROUND` finally written. Needs Q4.

### Phase 9 — collections for every domain *(additive; 5–8 d)*

Enable `capabilities.catalogue.collections` for retail; channel-scoped
assortments.

### Deferred drops

A separate migration, **no earlier than two releases after Phase 3**, drops
`MenuItem`, `MenuItemModifierGroup`, `MenuItemStationLink`, `MenuAvailability`,
`MenuItemChannelPrice`, `RestaurantOrderItem.menuItemId`,
`RestaurantOrderItem.sourceKind`, `RestaurantOrderChannel`. Its own decision
record; not part of this plan's value delivery. (`TILE_SHOP` / `RETAIL` are
NOT here — they carry no data, so §4.8.1 removes them in Phase 0.)

---

## 12. Production data migration — nothing is deleted

The system is **live in production** (the pilot tenant on axlopos.com, with
real sales, payments, returns, QuickBooks documents and audit history). This
section is the binding statement of how every phase treats that data. Its one
absolute rule:

> **No production row is deleted, truncated or overwritten-with-loss by any
> phase of this plan.** Structures scheduled for removal are frozen and
> retained until a separate, later drop decision with its own record. Every
> reconstructed or reclassified row is permanently distinguishable from a
> natively-written one.

### 12.1 The playbook every phase follows

Deployment order, always:

```
1. EXPAND    — additive migration (new tables / nullable columns / defaults).
               Old code keeps running against the new schema unchanged.
2. DUAL-WRITE— deploy code that writes both old and new shapes. Reads unchanged.
3. BACKFILL  — an operational script, NEVER inside `migrate deploy`:
               idempotent · resumable · dry-run mode first · row-count
               reconciliation · marker column on everything it writes.
4. VERIFY    — reconciliation queries against production; PO sign-off wherever
               financial history is touched.
5. SWITCH    — reads move to the new shape. Old shape still being written.
6. QUIESCE   — old shape stops being written but is NEVER emptied.
7. (CONTRACT)— dropping the old shape is OUTSIDE this plan: a separate
               migration, two releases later at the earliest, own decision
               record.
```

Rollback at any step ≤ 5 is "turn the new path off"; the old shape is still
complete and authoritative. That property — not speed — is why backfills are
operational steps rather than part of the migration: `migrate deploy` must
never be the thing that reconstructs financial history.

Every backfill script ships with: a `--dry-run` mode emitting a per-tenant
report (rows to create, rows skipped, anomalies); an idempotency key (re-runs
create nothing twice); and a hard abort if any invariant check fails mid-run
rather than a partial commit.

### 12.2 Existing data, table by table

What each phase does to rows that exist in production today. "Frozen" =
retained, readable, no longer written.

| Table | Existing rows | What changes | Backfill | Ever deleted? |
|---|---|---|---|---|
| `Tenant`, `Branch`, `Register`, `User`, `Role` | untouched | — | — | no |
| `TenantBusinessProfile` | pilot tenant has **no row** | gains one (§12.3.1) | yes — one row, behaviour-preserving | no |
| `Sale` (retail, live) | untouched | new columns arrive with correct defaults: `fulfilmentKind=IMMEDIATE`, `channel=COUNTER`, `sourceKind` semantics n/a | none needed — the defaults are the truth for every existing retail sale | no |
| `Sale` (restaurant/hotel) | header-only today | same columns | yes — `fulfilmentKind`/`channel` derived via `TableSession.finalSaleId` → order (§12.3.2) | no |
| `SaleItem` | retail lines untouched | `productId` becomes nullable (widening); `sourceKind` defaults `RETAIL_CART` — correct for **all** existing rows, since restaurant sales have none | historical restaurant lines reconstructed (§12.3.2) | no |
| `Payment`, `Receipt`, `Return`, `RefundPayment`, `Quotation` | untouched | Phase 6 satellite only | QBO refs copied out, columns kept | no |
| `Product` | untouched | `sellableKind` added with default `STOCK_ITEM` | reclassification UPDATE (§12.3.3) — changes one new column only | no |
| `MenuItem` + `MenuSection`, `Menu*` children | **frozen** in Phase 3 | no writes after cutover | placements + missing Products created *from* them; `migratedProductId` written back | **no — retained indefinitely**; KOT reprint / order detail / receipts keep resolving |
| `RestaurantOrder`, `OrderRound`, `RestaurantOrderItem`, modifiers | untouched — stay the operational record | `productId` populated on legacy rows (§12.3.3) | yes | no |
| `KitchenTicket*`, `BillSplit*`, `TableSession`, reservations, floor | untouched | — | — | no |
| `BranchInventory`, `StockMovement` | untouched | **no retroactive adjustment, ever** (§12.3.5) | none | no |
| `QuickBooksConnection` | untouched | — | — | no |
| `QuickBooksMapping` | migrated into `ExternalEntityRef` (rows copied, source kept until the drop decision) | Phase 6 | yes — §8.10 | no |
| `AuditLog`, `DocumentSequence`, `RefreshToken` | untouched | — | — | no |

### 12.3 Per-phase mechanics

#### 12.3.1 Phase 0 — the pilot tenant is classified as HARDWARE

**PO decision: the pilot tile shop is a hardware-template business.** Today it
is classified as nothing — it has no `TenantBusinessProfile` row and resolves
through `LEGACY_TENANT_DEFAULTS` (code, not data). The migration makes its
classification real data:

1. **Verified equivalence, not assumed:** `DEFAULT_MODULES_BY_BUSINESS_TYPE
   [HARDWARE]` = shared core (6) + retail (7) = the exact 13-module list in
   `LEGACY_TENANT_DEFAULTS.enabledModules`, and the profile preset pair
   (`QUICKBOOKS`/`QUICKBOOKS`) is identical. Writing the row therefore changes
   **no effective behaviour**. (The D55 decision record's "known gap" note
   assumed the two module lists might differ; this review checked — they are
   the same set. The decision record should be corrected when this ships.)
2. Backfill: one `TenantBusinessProfile` row for the pilot —
   `businessType: HARDWARE, inventoryMode: QUICKBOOKS, accountingProvider:
   QUICKBOOKS` — inside the same deploy as the §4.8.1 code changes.
3. Guard, before and after, in production: capture `GET /platform/profile`
   for the pilot tenant and diff. The only permitted changes are
   `businessType: TILE_SHOP → HARDWARE` and `source: LEGACY_DEFAULT →
   EXPLICIT`; a different module list or provider pair aborts the deploy.
4. The legacy no-row fallback **stays in the code** — it is the documented
   compatibility contract and other no-row tenants may exist. Only its
   `businessType` constant changes (`TILE_SHOP` → `HARDWARE`, §4.8.1).
5. The enum-recreation migration removing `TILE_SHOP`/`RETAIL` runs **after**
   the pilot's row is written, with the §4.8.1 zero-rows guard.

Result: the platform console attributes the pilot to the Hardware template
(closing D55's "Legacy default" gap), and the only user-visible change is the
Settings → Business label reading "Hardware store".

#### 12.3.2 Phase 1 — settlement lines for existing sales

Two distinct backfills, run in this order:

**(a) Restaurant/hotel `Sale` headers get their fulfilment facts.** Every
existing `Sale` reached from `TableSession.finalSaleId` is updated to
`fulfilmentKind = TABLE_SERVICE`, `sourceRefKind/'sourceRefId'` pointing at the
session, `servedByUserId = session.waiterUserId`, and `channel` read from the
session's order (`DINE_IN`/`TAKEAWAY`/`ONLINE`). Retail sales are not touched
— their column defaults are already correct, which is why those defaults were
chosen.

**(b) Historical `SaleItem` reconstruction (Q1).** For every CLOSED session:
walk `TableSession → RestaurantOrder → RestaurantOrderItem` (non-voided), and
write one `SaleItem` + `SaleItemModifier` set per line, copying the snapshots
that were frozen at submit time (`menuItemName`, `unitPrice`,
`modifierTotal`, variant snapshots) — **a field-for-field copy of data that
already exists, not a recomputation.**

- Marker: every reconstructed row carries `backfilledAt` (column added for
  this purpose), so reconstructed financial detail is distinguishable from
  natively-written detail forever.
- Invariant, per sale: `Σ lineTotal == Sale.subtotal` (the subtotal the
  customer actually paid). A sale that fails lands on a discrepancy report
  with **no rows written for it** — a wrong reconstruction is worse than an
  absent one, because nothing distinguishes it from truth later.
- Dry-run report reviewed by the PO before the live run (per-tenant counts,
  sum-matched vs discrepant sales).
- Idempotent via `@@index([sourceKind, sourceItemId])` — a re-run finds the
  projection already present and skips.

Until (b) has run, `GET /sales/:id` for an old restaurant sale simply keeps
returning `items: []` exactly as today — absence of backfill is never an
error state.

#### 12.3.3 Phase 3 — catalogue reclassification and placement backfill

1. **`Product.sellableKind`** — an UPDATE on the new column only:
   `type = 'Service'` → `SERVICE`; `foodType IS NOT NULL` → `COMPOSED_ITEM`;
   everything else keeps the default `STOCK_ITEM`. The pilot's QuickBooks
   `type` column is **not modified** — it remains the sync payload field.
2. **`MenuItem` → placements.** Per §8.5: linked items get a
   `CatalogueEntry`; unlinked items get a new `Product` first
   (`sellableKind = COMPOSED_ITEM`, scalars copied) with the new id written
   back to `MenuItem.migratedProductId`. Modifier and station junctions are
   copied where missing. Dry-run + duplicate-by-name report (Q2) before the
   live run.
3. **`RestaurantOrderItem.productId`** is populated on legacy `MENU_ITEM`
   rows via `migratedProductId`, so kitchen/billing/report readers can switch
   to one lookup. `menuItemId` keeps its value on every historical row.
4. **`MenuItem` and children are frozen, not dropped.** All historical
   references — KOT reprints, order detail, receipts — continue to resolve
   against the retained rows and the snapshots on the order items.

#### 12.3.4 Phase 6 — QuickBooks data movement

Fully specified in §8.10. The data rules restated from the production
standpoint: `QuickBooksMapping` rows are **copied** into `ExternalEntityRef`,
not moved; the vendor columns on the eight core models keep their last-written
values after the quiesce step; and nothing observable changes for the pilot
tenant's accountant — same documents, same ids, same sync behaviour.

#### 12.3.5 Phase 8 — stock history is never rewritten

Component-based depletion starts **at cutover, forward only**. Historical
restaurant stock figures are purchase-side only today (D-5); they stay that
way. No retroactive `StockMovement` rows are synthesised — fabricating
movements for sales that never depleted would falsify the ledger's
`balanceAfter` chain. Instead, enabling components for a tenant prompts an
**opening stock-take** (the existing `ADJUSTMENT`/`OPENING` reasons), which is
the honest way to make the ledger match the shelf from a known instant.

### 12.4 Structures retained indefinitely

Frozen by this plan and removed only by a future drop decision (own record,
≥ two releases later): the `MenuItem` family and its junctions,
`RestaurantOrderItem.menuItemId` + `sourceKind`, `RestaurantOrderChannel`,
the QBO columns on the eight core models, and `QuickBooksMapping`. Every one
carries a schema comment naming the phase that froze it and the decision that
may remove it. **None of them blocks any phase of this plan** — retention is
free apart from disk, and disk is cheaper than a wrong delete on a production
financial system.

---

## 13. Test obligations (D30)

### 13.1 New tripwires

| Tripwire | Asserts | Mutation proof |
|---|---|---|
| `domain-registry.spec.ts` | `DOMAIN_REGISTRY` is total over `BusinessType`; every descriptor is complete; **no `??` fallback exists in any domain lookup** | deleting an entry fails the build; adding a fallback fails the test |
| `domain-single-authority.spec.ts` | business-type string literals appear in exactly one file per workspace | reintroducing one inline predicate fails it |
| `capabilities-parity.spec.ts` | the food-service domains are `deepEqual` on capabilities while HOTEL is a distinct object (so a future divergence is a visible edit) | pointing HOTEL at retail capabilities fails it |
| `nav-icon-totality.spec.ts` | every `NavIconName` used by a descriptor resolves in `NAV_ICONS` | naming a missing icon fails the build |
| `sale-item-projection.spec.ts` | a closed session yields `SaleItem` rows whose count and `Σ lineTotal` match the non-voided order items | deleting the projection fails it; returning `[]` fails it |
| `money-single-authority.spec.ts` | `taxRatePercent` is read in exactly one module | reintroducing the calc in `sales.service` fails it |
| `catalogue-single-authority.spec.ts` | no service reads `menuItem.basePrice` after Phase 3 | restoring one reader fails it |
| `fulfilment-provider-contract.spec.ts` | every registered provider implements the full interface and every `FulfilmentKind` maps to one | adding a kind without a provider fails it |
| `sellable-query-count.spec.ts` | `/products/sellable` issues a constant number of queries for 1 vs 200 products | reintroducing an N+1 fails it |
| `attribute-schema-validation.spec.ts` | an attribute not in the tenant's schema is rejected; one in it is accepted | accepting anything fails the negative half |
| `quickbooks-isolation.spec.ts` | the identifiers `quickbooks*` / `syncStatus` / `ExternalEntityRef` are referenced **only** from `modules/quickbooks/**`, `modules/sync/**` and `providers/**/quickbooks-*` — asserted as an exact importer **set**, not a count | adding a read in `products.repository` fails it; renaming the analyser's target symbol makes it inspect zero files and **fail**, per D30 rule 7 |
| `quickbooks-domain-scope.spec.ts` | exactly the QBO-enabled business types carry `accountingProvider: 'QUICKBOOKS'` **and** `ModuleKey.QUICKBOOKS`, and every other descriptor carries neither | copy-pasting the retail descriptor for a new domain fails it — the specific failure §4.9.5 exists to prevent |
| `quickbooks-payload-scope.spec.ts` | a non-QuickBooks tenant's `/products` and `/sales` payloads contain **no** `quickbooks*` or `syncStatus` key, while a QuickBooks tenant's contain all of them | emitting `null` instead of omitting fails the first half; omitting for everyone fails the second |
| `removed-business-types.spec.ts` | after Phase 0, the literals `TILE_SHOP` and `RETAIL` appear **nowhere** outside migration history; positively, the enum contains exactly the expected value set | reintroducing either literal fails it; an analyser that inspects zero files fails, per D30 rule 7 |

### 13.2 Existing tripwires to update per phase

- `provider-contract.spec.ts` — exact migration list, `scanned.length`, and a
  per-migration additive proof. **Phase 1's proof must be extended** to permit
  `DROP NOT NULL` while still forbidding `SET NOT NULL`.
- `route-module-matrix.spec.ts` + `docs/restaurant-pos/route-module-matrix.md` —
  exact route map and the three totals, per phase.
- `controller-registry.ts` — every new controller.
- `module-key-contract.spec.ts` — replaced by the generated union (§4.8), which
  removes the brittle regex parse that broke twice during D55.

### 13.3 Differential test (Phase 2, mandatory before switching)

Run the old float calculator and the new Decimal calculator over generated
inputs — line counts 1–50, quantities with 3 decimals, per-line and order
discounts, tax rates 0/5/8/15/18/20 — and assert cent-exact equality. Any
divergence goes to the PO as a finding, never to a relaxed assertion.

### 13.4 The extensibility test

One test that proves §1.4's contract rather than asserting it in prose: a
fixture `DomainDescriptor` for a fictional vertical, registered in a test-only
registry, asserted to produce a complete module set, navigation, role set,
capability object and workspace template **without touching any production
file**. If that test needs a production edit to pass, the architecture has not
been delivered.

---

## 14. Open decisions

Each needs a `00-decisions.md` entry before the phase it blocks.

**Q1 — Backfill `SaleItem` for already-closed restaurant sessions?**
Reconstructing lines for settled sales adds detail that was always implied but
rewrites financial history. *Blocks Phase 1 step 5.*
**Recommendation:** run it, with a dry-run report and a `backfilledAt` marker so
reconstructed rows stay distinguishable from natively-written ones forever.
Full mechanics, invariants and the no-rows-on-mismatch rule are specified in
§12.3.2.

**Q2 — Auto-create Products for unlinked `MenuItem` rows?**
Grows the catalogue and may duplicate products a tenant created by hand during
the D45 transition. *Blocks Phase 3.*
**Recommendation:** auto-create, plus a "possible duplicate" report by
case-insensitive name match. D45's "no auto-conversion" was about not forcing UX
change; it should not mean stranding data.

**Q3 — Which capabilities does a retail tenant get?**
The schema already supports modifiers and collections for retail. *Affects
`RETAIL_CAPABILITIES` in Phase 0.*
**Recommendation:** modifiers **yes** (cut-to-length, key cutting, delivery
options are real), collections **not yet** (ship the flag off).

**Q4 — Do composed items deplete at submit or at settle?**
Submit matches physical reality and `ORDER_ROUND`'s name; settle matches the
retail path and makes voids trivial. *Blocks Phase 8.*
**Recommendation:** **submit**, with a compensating movement on void. It is the
only option that keeps stock honest during a long service, and D53 already
established that food reaching the kitchen is the event that matters.

**Q5 — Per-branch tax rate?**
A genuine feature, not just a refactor. *Affects Phase 2 scope.*
**Recommendation:** ship the nullable column and the fallback; build no UI until
asked.

**Q6 — `cashierId` vs `servedByUserId`.**
D52 set `cashierId = session.waiterUserId ?? actorUserId`. Once
`groupBy=servedBy` replaces waiter-performance reporting, that column carries
two meanings. *Affects §9.2's reporting collapse.*
**Recommendation:** add `Sale.servedByUserId` in Phase 1; `cashierId` keeps
meaning "who took the money", which is what it means for retail.

**Q7 — How far does HOTEL diverge, and when?**
Today it is food service under another name. A real hotel needs room-nights,
folios, a `STAY` fulfilment provider and `ROOMS` / `HOUSEKEEPING` modules.
*Affects the shape of `hotel.domain.ts` in Phase 0.*
**Recommendation:** give HOTEL its **own descriptor file** from day one that
happens to re-export the food-service values. A separate file that looks
redundant today is a one-file edit when it diverges; an alias is a refactor.

**Q8 — Do domains ever compose?**
A hotel with a restaurant, a garden centre with a café. Today a tenant has one
`BusinessType`; the honest answer is one workspace per outlet. *Affects nothing
now; affects everything if the answer changes.*
**Recommendation:** record explicitly that composition is **out of scope**, and
that multi-outlet tenants use one workspace per outlet or one branch per outlet.
If composition is ever needed, `BusinessType` becomes a set and `DomainDescriptor`
gains a merge operator — which the descriptor shape already permits, but nothing
should be built for it speculatively.

**Q9 — Should `RETAIL` keep the QuickBooks preset? — RESOLVED**
Superseded by the PO's consolidation decision: the Hardware template and the
Tile Shop are one entity, and there is no Retail template. `HARDWARE` is
the only value; `TILE_SHOP` and `RETAIL` are removed (§4.8.1), so `RETAIL` no longer
has a preset to argue about. The remaining sub-decision for the record is only
the visible label change: legacy no-profile tenants will read "Hardware store"
instead of "Tile shop" on the Settings → Business page.

**Q10 — What happens to `syncStatus` as a public query parameter?**
`QueryProductsDto` and `QuerySalesDto` accept it for every tenant.
*Affects Phase 6 step 6.*
**Recommendation:** reject with `400 QUICKBOOKS_MODULE_REQUIRED` when the module
is disabled, rather than silently ignoring it. Silently ignoring a filter is how
a caller ends up trusting an unfiltered list.

**Q11 — Is a second accounting provider ever expected?**
The `ExternalEntityRef` design costs slightly more than a QuickBooks-only
satellite and pays off only if a second integration arrives (Xero, Zoho, a local
tax authority filing).
*Affects the shape of §4.9.4 — `provider` column or not.*
**Recommendation:** keep the `provider` column regardless. It is one `String`
and one index position, it makes the table's purpose self-describing, and
retrofitting it later means a unique-constraint migration on a table holding
every external identity in the system.

---

## 15. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Phase 2 shifts a retail total by a cent | Medium | High — real money, live tenant | Differential test before switching (§13.3); no editing existing assertions (D16) |
| R2 | Phase 3 backfill creates duplicate products | Medium | Medium | Dry-run + duplicate-by-name report (Q2) |
| R3 | Phase 1 projection disagrees with the bill the customer already saw | Low | High | In-transaction `Σ lineTotal == subtotal` assertion; fail the close |
| R4 | `DomainDescriptor` becomes a god-object | Medium | Medium | It declares **only** the thirteen axes in §4.1; a fourteenth needs a decision. Behaviour goes to a provider, not a field |
| R5 | `attributes` JSON becomes a dumping ground | High | Medium | The §4.6 rule is a contract test: no pricing/tax/inventory/settlement module may read `attributes` |
| R6 | Route-matrix tripwire churn over 8 phases | High | Low | Update per phase, never in bulk. It caught the D55.1 route correctly and should keep doing so |
| R7 | QuickBooks retail path regresses while touching `Product` | Low | High | D28/D31 boundary already isolates the *provider*; the *columns* are not isolated (D-9), so add no new QBO reads outside the provider and treat every `Product` change as touching sync until Phase 6 lands |
| R10 | **Phase 6 breaks live QuickBooks sync** | Low | **Critical** — the only paying integration | Eight individually revertible steps (§8.10); dual-write before any read switch; a full production reconciliation cycle at step 4 before step 5; low-traffic entity types first, `Sale`/`Payment` last |
| R11 | Phase 6 is deferred indefinitely because it is invisible | **High** | Medium | Every domain added meanwhile inherits nine dead `Product` columns, a useless `Sale` index and a meaningless public query parameter. The cost is silent and compounding — which is exactly why it is scheduled rather than left as "opportunistic" |
| R8 | Long dual-model window (Phases 3–9) confuses contributors | High | Medium | Every transitional column carries a schema comment naming the phase that removes it |
| R9 | Phase 0 lands and Phase 4 is skipped as "not urgent" | **High** | High | Phases 0–3 deliver visible value and Phase 4 delivers none until domain #4 arrives — so it will feel skippable. It is the phase the extensibility promise rests on. Sequence it before Phase 5 for exactly this reason |

---

## 16. Non-goals

- **Does not merge the POS workspaces.** Fulfilment differs; the UI should too.
- **Does not introduce a unified `Order` table.** §3.3.
- **Does not rename `/products` to `/catalogue`.** §9.1.
- **Does not rename `KitchenStation` to `FulfilmentStation`.** §8.6.
- **Does not move QuickBooks columns off `Product` now.** §8.3.
- **Does not drop a single table.** Every phase is additive.
- **Does not build multi-level recipes, yield management or variance reporting.**
- **Does not build composed domains** (hotel *with* restaurant). Q8.
- **Does not build the salon or hotel verticals.** §4.7 works them through only
  to prove the architecture holds.
- **Does not change the inventory or accounting provider *interfaces*.** D28/D31
  are correct and are the model this plan follows. Phase 6 changes where the
  QuickBooks provider's *data* lives, not what it does.
- **Does not build a second accounting provider.** `ExternalEntityRef` carries a
  `provider` column so that one would be cheap, not because one is planned.
- **Does not change any QuickBooks behaviour a hardware tenant can observe.**
  Same routes, same sync semantics, same documents. If a hardware tenant can
  tell Phase 6 happened, Phase 6 is wrong.
- **Does not extend QuickBooks to any other template.** Per the PO constraint,
  every non-retail descriptor declares `accountingProvider: 'NONE'`, and a
  tripwire enforces it (§13.1).

---

## Appendix A — divergent pairs, complete inventory

| # | Retail artefact | Restaurant artefact | Resolution | Phase |
|---|---|---|---|---|
| 1 | `Product` | `MenuItem` | `Product` + `CatalogueEntry` | 3 |
| 2 | `ProductModifierGroup` | `MenuItemModifierGroup` | `ProductModifierGroup` | 3 |
| 3 | `ProductStationLink` | `MenuItemStationLink` | `ProductStationLink` | 3 |
| 4 | `ProductCategory`/`Subcategory` | `Menu`/`MenuSection` | both survive — taxonomy vs curation | 8 |
| 5 | `SaleItem` | `RestaurantOrderItem` | both survive — financial vs operational, with a projection | 1 |
| 6 | — | `RestaurantOrderItemModifier` | + `SaleItemModifier` | 1 |
| 7 | `sales.service` totals | `restaurant-totals.ts` | `computeDocumentTotals` | 2 |
| 8 | `quotations.calc.ts` totals | — | `computeDocumentTotals` | 2 |
| 9 | `TenantSettings.data.taxRatePercent` | `RestaurantBranchConfig.*` | typed per-branch config with tenant fallback | 2 |
| 10 | `sales-report.service` | `restaurant-reports.service` | one query layer, both route sets | 5 |
| 11 | `GET /products/search` | `GET /restaurant/pos-catalogue` | `GET /products/sellable` | 5 |
| 12 | `lib/products-api.ts` | `lib/restaurant/pos-catalogue-api.ts` | one client | 5 |
| 13 | `lib/cart.ts` | `lib/pos-cart.tsx` | one cart interface | 5 |
| 14 | `RestaurantOrderChannel` | — | `OrderChannel` incl. `COUNTER` | 1 |
| 15 | `Product.type` (QBO string) | `Product.foodType` | `sellableKind` (behaviour) + `foodType` (presentation) | 3 |
| 16 | 7 inline business-type predicates | — | `TenantCapabilities` | 0 |
| 17 | `receipts.repository` ← `Sale` | `billing.service` ← `RestaurantOrderItem` | both ← `SaleItem` once settled | 1 |
| 18 | 7 scattered by-business-type maps | — | `DomainDescriptor` | 0 |
| 19 | implicit retail lifecycle | `table-sessions` + `takeaway` | `FulfilmentProvider` | 4 |
| 20 | QBO columns on 8 Layer-1 models | dead columns inherited by every domain | `ExternalEntityRef` | 6 |
| 21 | `QuickBooksMapping` (2 readers) | — | generalised into `ExternalEntityRef` | 6 |
| 22 | `syncStatus` as a public query param | meaningless for the tenant | gated on the QUICKBOOKS module | 6 |

## Appendix B — files most affected

| File | Phases | Nature |
|---|---|---|
| `packages/shared/src/domains/**` | 0 | **new** — the registry |
| `packages/database/prisma/schema.prisma` | 1,2,3,6,7,8 | additive |
| `apps/web/src/lib/nav.ts` | 0 | source becomes the descriptor; 38 tests unchanged |
| `apps/web/src/lib/products/product-presentation.ts` | 0 | folded into capabilities |
| `apps/web/src/app/(app)/pos/page.tsx` + 6 siblings | 0 | predicates deleted |
| `apps/api/src/modules/platform/platform.constants.ts` | 0 | module map moves to descriptors |
| `apps/api/src/modules/platform-admin/workspace-templates.ts` | 0 | derived from the registry |
| `packages/shared/src/types/role-templates.ts` | 0 | `if` chain replaced by descriptors |
| `apps/api/src/modules/table-sessions/table-sessions.service.ts` | 1,3,4,7 | projection, reads, provider extraction |
| `apps/api/src/modules/takeaway/takeaway.service.ts` | 1,3,4,7 | same |
| `apps/api/src/modules/sales/sales.service.ts` | 2,4 | money engine, provider extraction |
| `apps/api/src/modules/quotations/quotations.calc.ts` | 2 | money engine |
| `apps/api/src/modules/restaurant/restaurant-totals.ts` | 2 | widened, moved |
| `apps/api/src/modules/restaurant/pos-catalogue.service.ts` | 5 | becomes `/products/sellable` |
| `apps/api/src/modules/menu/**` (1,500 lines) | 3 | deleted after transition |
| `apps/api/src/modules/kitchen/kitchen.service.ts` | 3 | dual-branch lookup collapses |
| `apps/api/src/modules/billing/billing.service.ts` | 1,3 | settled bill reads `SaleItem` |
| `apps/api/src/modules/restaurant-reports/**` | 5 | re-implemented over shared queries |
| `apps/api/src/modules/quickbooks/**`, `modules/sync/**` | 6 | read from `ExternalEntityRef` instead of core columns |
| `modules/products/{repository,service}.ts`, `dto/query-products.dto.ts` | 6 | stop reading vendor state |
| `modules/sales/{service,repository,types}.ts`, `dto/query-sales.dto.ts` | 6 | stop reading vendor state |
| `modules/categories/categories.repository.ts`, `modules/customers/**` | 6 | stop reading vendor state |
| `modules/{sales-report,products-report}.service.ts` | 6 | stop selecting vendor columns |
| `apps/web/src/components/restaurant/menu/**` | 3 | deleted |
| `apps/api/src/common/guards/route-module-matrix.spec.ts` | every | tripwire upkeep |
| `apps/api/src/modules/providers/provider-contract.spec.ts` | 1,2,3,6,7,8 | per-migration additive proofs |

## Appendix C — decision records this plan would create

| ID | Title |
|---|---|
| D56 | Domain packs: one `DomainDescriptor` per vertical; the registry is total and has no fallback |
| D57 | Tenant capabilities replace business-type comparisons everywhere |
| D58 | The settlement document is universal: every completed transaction writes `SaleItem` |
| D59 | One money calculator, `Prisma.Decimal` throughout, for sales, bills and quotations |
| D60 | `Product` is the only catalogue; `MenuItem` becomes a placement and is retired |
| D61 | `sellableKind` is AxloPOS's vocabulary; the QuickBooks `type` is provider data |
| D62 | `FulfilmentProvider`: the third provider axis, alongside inventory and accounting |
| D63 | Domain attributes are JSON validated against a declared schema; behaviour stays in columns |
| D64 | Composed items deplete through a one-level component list at round submit |
| D65 | Catalogue REST surface: `/products` is canonical, `/products/sellable` is the POS read model |
| D66 | Deferred drops: the transitional `MenuItem` tables are removed two releases after D60 |
| D67 | Domain composition is out of scope; multi-outlet tenants use one workspace per outlet |
| D68 | QuickBooks is the hardware template's integration only; no other domain enables it |
| D71 | One business type per template: `HARDWARE` only; `TILE_SHOP` and `RETAIL` removed (zero data, enum-recreation migration) |
| D69 | External identity lives in `ExternalEntityRef`; no Layer-1 model gains a vendor-named column |
| D70 | Vendor fields are absent — not null — from payloads for tenants without the integration |
