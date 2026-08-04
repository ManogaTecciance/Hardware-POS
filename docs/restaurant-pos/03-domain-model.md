# Restaurant domain model

Status: **specification only.** No restaurant table is created in Phase 1.
Shapes below are for review, not implementation.

## Bounded contexts

| Context | Aggregate root | Owns | Phase |
|---|---|---|---|
| Menu | `Menu` | sections, items, modifier groups/options, channel prices, availability windows, product mapping | 3 |
| Floor | `DiningArea` | tables, capacity, labels, layout, table status | 4 |
| Service | `TableSession` | waiter, guest count, lifecycle, merge/transfer, running bill | 5 |
| Ordering | `RestaurantOrder` | rounds (immutable), items, item modifiers, status history | 5 |
| Kitchen | `KitchenTicket` | stations, ticket items, print attempts, prep status | 6 |
| Takeaway | `TakeawayOrder` | pickup time, handover, payment status | 7 |
| Billing | `Sale` *(shared core)* | service charge, splits, mixed payments, voids | 8 |
| Channels | `ExternalOrder` | webhooks, normalisation, mapping, acceptance, settlement | 10-12 |

### Boundary rules

- Ordering never writes `Sale`.
- Billing never writes `RestaurantOrderItem`.
- Kitchen never mutates prices.
- Channels never writes `RestaurantOrder` directly — it goes through Ordering's
  public service, so KOT generation, audit, and idempotency are identical for a
  dine-in round and an Uber Eats order.
- **One junction point:** closing a `TableSession` produces a `Sale`. Everything
  downstream (payments, receipts, reports, dashboards, accounting) is reused.

## Schema conventions for every new table

- `tenantId`, plus `branchId` where meaningful.
- `@@index([tenantId])`; `@@unique` on natural keys.
- `Decimal(12, 2)` money; `Decimal(12, 3)` quantity.
- `createdAt` / `updatedAt`.
- `version Int @default(1)` on anything mutated concurrently (`TableSession`,
  `RestaurantOrder`) — the repository has **no** `version` column today.
- Status history as its own table, never an overwritten column.
- `isActive` soft delete on configuration entities.
- Snapshot denormalised names/prices onto immutable lines, following `SaleItem`,
  `ReturnItem`, and `QuotationItem`.

## Reusable primitives already in the codebase

| Existing asset | Reused for |
|---|---|
| `DocumentSequence` + `nextDocumentNumber` (atomic `INSERT … ON CONFLICT DO UPDATE`) | order, KOT, takeaway, and session numbers |
| `Return.@@unique([tenantId, idempotencyKey])` | round submission, webhook dedup, payment posting |
| `Quotation.convertedSaleId @unique` | `TableSession.finalSaleId @unique` (double-close guard) |
| `QuotationRevision` immutable chain | `OrderRound` immutability — the closest existing analogue |
| `decrementStock` conditional-update idiom | every atomic restaurant state transition |
| `common/money.ts` (`round2`, `sum2`) | all restaurant money maths, so a closed session and a retail sale round identically |
| `AuditLogService` | all 26 audited restaurant actions |
| `DiscountsService` approval-token flow | bill discounts, complimentary items, manager-approved voids |

## Planned tables by phase

| Phase | Tables |
|---|---|
| 3 | `Menu` `MenuSection` `MenuItem` `MenuItemProductMapping` `ModifierGroup` `ModifierOption` `MenuItemModifierGroup` `MenuItemChannelPrice` `MenuAvailability` |
| 4 | `DiningArea` `RestaurantTable` `KitchenStation` `MenuItemKitchenStation` |
| 5 | `TableSession` `RestaurantOrder` `OrderRound` `RestaurantOrderItem` `RestaurantOrderItemModifier` `RestaurantOrderStatusHistory` |
| 6 | `KitchenPrinter` `KitchenTicket` `KitchenTicketItem` + `PrintJob` widening |
| 7 | `TakeawayOrderProfile` |
| 8 | `Sale` widening (`serviceChargeAmount`, `packagingCharge`, `idempotencyKey`, `version`), `BillSplit` |
| 10-12 | `DeliveryPlatform` `PlatformStoreConnection` `ExternalMenuMapping` `ExternalOrder` `ExternalOrderItem` `ExternalOrderModifier` `ExternalOrderEvent` `ExternalOrderStatusHistory` `ExternalPaymentBreakdown` `PlatformSettlement` `IntegrationError` `WebhookDeliveryLog` |

## Branch-scoped inventory (Phase 2.5, decision D10)

`Product.quantityOnHand` is tenant-wide, so multi-branch stock is already incorrect
for retail. Scheduled after branch scoping (Phase 2) and before table sessions
(Phase 5).

```prisma
enum StockMovementReason { SALE RETURN ADJUSTMENT TRANSFER_IN TRANSFER_OUT IMPORT QB_PULL WASTAGE OPENING }

model BranchInventory {                    // current balance, per branch
  id, tenantId, branchId, productId
  quantityOnHand Decimal  @default(0) @db.Decimal(12, 3)
  reorderLevel   Decimal? @db.Decimal(12, 3)
  version        Int      @default(1)
  @@unique([branchId, productId])
  @@index([tenantId])
  @@index([productId])
}

model StockMovement {                      // append-only ledger, never updated
  id, tenantId, branchId, productId
  delta           Decimal @db.Decimal(12, 3)
  balanceAfter    Decimal @db.Decimal(12, 3)
  reason          StockMovementReason
  refType         String?   // 'SALE' | 'RETURN' | 'ORDER_ROUND' | …
  refId           String?
  createdByUserId String?
  createdAt       DateTime @default(now())
  @@index([tenantId, productId, createdAt])
  @@index([refType, refId])
}
```

Four-step non-destructive rollout:

| Step | Action | Destructive? |
|---|---|---|
| 1 | Add both tables. No reader changes. | No |
| 2 | Backfill one `BranchInventory` row per (default branch × product) from `Product.quantityOnHand`; write an `OPENING` movement for each. | No — insert only |
| 3 | `LocalInventoryProvider` **dual-writes** `BranchInventory` (authoritative) and `Product.quantityOnHand` (tenant-wide rollup + QuickBooks cache). Readers unchanged. | No |
| 4 | Migrate readers behind a flag; verify the rollup equals the sum of branches. | No |

`Product.quantityOnHand` is **retained permanently** as the QuickBooks cache mirror
and tenant-wide rollup — never dropped, never repurposed (decision D10).

> `quantityOnHand` currently has roughly 35 read/write sites across 35 files,
> 15 of them frontend. This is a cross-stack change, not a schema change — which
> is why it is a phase of its own, and why the Phase 1 `InventoryProvider` port is
> the precondition for doing it safely.

## Exchanges (decision D2)

The repository contains an Exchange **A4 document renderer**
(`documents.service.ts` — `buildExchangeDocument`, `ExchangeLine`, the `'exchange'`
preview type) and nothing else. There is no Exchange Prisma model, migration, API
module, route, permission key, or E2E spec.

- The renderer and its current output are preserved; regression coverage is kept
  (`documents.preview.spec.ts`, plus manual cases `SET-013` and `DOC-014`).
- `EXCHANGES` is reserved as a `ModuleKey` and hidden for Restaurant tenants.
- Exchanges are **not** represented as a fully implemented transaction feature.
- Future Exchange transaction test cases are marked
  `Blocked — feature not implemented`.
- No Exchange transaction workflow is created in Phase 1.
