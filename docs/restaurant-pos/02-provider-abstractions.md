# Provider abstractions

Status: **specification.** Inventory and accounting ports are Phase 1 Slice 5
(not yet authorised). Printing is Phase 6. Delivery is Phase 10.

## Why ports at all

QuickBooks must become optional without spreading `if (quickbooks)` through shared
business logic, and without removing a single QuickBooks column or workflow. The
mechanism is dependency injection behind a narrow port, resolved per tenant from
`TenantBusinessProfile`.

The repository already contains a working precedent: `common/storage/`
(`StorageProvider` + `create-storage-provider.ts`, with local-disk and S3
implementations). The inventory and accounting ports follow that shape.

## The critical constraint: transaction awareness

Existing writes happen **inside** a Prisma `$transaction`:

- `sales.repository.ts` — `decrementStock(tx, …)` then `enqueueSaleSync(tx, …)`,
  both inside the sale transaction. The conditional
  `updateMany({ where: { quantityOnHand: { gte: qty } } })` with a row-count check
  is the authoritative guard against overselling; a zero-row update rolls the
  entire sale back.
- `returns.repository.ts` — restock and `enqueueReturnSync(tx, …)` inside the
  return transaction (a transactional outbox, so a QuickBooks outage can never
  lose a return).

**Every provider mutator must therefore accept a `Prisma.TransactionClient` as its
first parameter.** A provider method that opens its own connection silently breaks
atomicity: overselling becomes possible again, and the outbox stops being an
outbox. This is the single highest-risk detail of the refactor and is covered by a
dedicated rollback test.

## `InventoryProvider`

```ts
export interface InventoryProvider {
  readonly mode: InventoryMode;

  getAvailability(tenantId: string, branchId: string, productIds: string[]): Promise<AvailabilityMap>;

  reserveStock (tx: Prisma.TransactionClient, ctx: StockContext, lines: StockLine[]): Promise<void>;
  reduceStock  (tx: Prisma.TransactionClient, ctx: StockContext, lines: StockLine[]): Promise<void>;
  restoreStock (tx: Prisma.TransactionClient, ctx: StockContext, lines: StockLine[]): Promise<void>;
  adjustStock  (tx: Prisma.TransactionClient, ctx: StockContext, adjustments: StockAdjustment[]): Promise<void>;

  synchronize(tenantId: string): Promise<SyncOutcome>;
}
```

| Implementation | Behaviour |
|---|---|
| `LocalInventoryProvider` | today's `decrementStock` logic, lifted verbatim; later also writes a `StockMovement` row (Phase 2.5) |
| `QuickBooksInventoryProvider` | today's exact behaviour — local decrement **and** QuickBooks as the downstream accounting authority |
| `NoInventoryProvider` | all mutators no-op; `getAvailability` reports unlimited |

`EXTERNAL` has no implementation in Phase 1; the factory throws a clear
"not implemented" error rather than silently falling back.

## `AccountingProvider`

```ts
export interface AccountingProvider {
  readonly provider: AccountingProviderKind;

  /** Which document a completed sale maps to. Returns null when there is no
   *  accounting integration — this is what removes the QuickBooks decision from
   *  sales.service. */
  resolveDocumentType(sale: SaleFinancialShape): SaleDocumentType | null;

  postSale      (tx: Prisma.TransactionClient, tenantId: string, saleId: string): Promise<void>;
  postPayment   (tx: Prisma.TransactionClient, tenantId: string, paymentId: string): Promise<void>;
  postRefund    (tx: Prisma.TransactionClient, tenantId: string, returnId: string): Promise<void>;
  postCreditNote(tx: Prisma.TransactionClient, tenantId: string, returnId: string): Promise<void>;

  synchronize(tenantId: string): Promise<SyncOutcome>;
}
```

| Implementation | Behaviour |
|---|---|
| `NoAccountingProvider` | `resolveDocumentType → null`; all posts no-op. **No `SyncJob` row, no `SyncLog` row, no fabricated QuickBooks document id.** |
| `QuickBooksAccountingProvider` | today's `enqueueSaleSync` / `enqueueReturnSync` behaviour, unchanged; `resolveDocumentType` returns today's `paidAmount >= total ? SALES_RECEIPT : INVOICE` and re-raises the identical "customer required for a credit sale" error message |

## What moves out of shared logic

Three QuickBooks leaks are removed from the core sale pipeline in Slice 6:

| Location today | Moves to |
|---|---|
| `sales.service.ts` — `quickbooksDocumentType = paymentStatus === 'PAID' ? 'SALES_RECEIPT' : 'INVOICE'` | `AccountingProvider.resolveDocumentType()` |
| `sales.service.ts` — `if (documentType === 'INVOICE' && !customerId) throw` | `QuickBooksAccountingProvider` only |
| `sales.repository.ts` / `returns.repository.ts` — unconditional `enqueue*Sync(tx, …)` | `AccountingProvider.postSale` / `.postRefund` |

The second one matters beyond tidiness. That check exists purely because a
QuickBooks Invoice requires a `CustomerRef`. Under `NoAccountingProvider` the
constraint is meaningless, and a restaurant running a tab for an unnamed walk-in
must not be blocked by a QuickBooks rule.

## `PrinterProvider` (Phase 6, decision D6)

Target: **80 mm network ESC/POS thermal printer.** The port must also support a
mock adapter, browser/system print fallback, multiple station printers, and future
USB/Bluetooth transports.

**Printer-specific code must not live inside restaurant order-domain services.**
Order services emit a ticket intent; the printing layer owns transport, retry,
failover, reprint marking, and attempt auditing.

Phase 1 deliberately does **not** touch `PrintJob`. Noted for Phase 6:
`PrintJob.saleId` is currently non-nullable, but a KOT exists before any `Sale`, so
it will need a nullable `saleId` plus a nullable kitchen-ticket reference, and
`attempts` / `printerId` / `isReprint` columns.

## `DeliveryPlatformAdapter` (Phase 10, decision D9)

`verifyWebhook` · `normalizeOrder` · `getOrderDetails` · `acceptOrder` ·
`rejectOrder` · `markPreparing` · `markReady` · `acknowledgePickup` ·
`processCancellation` · `updateAvailability` · `synchronizeMenu`.

`MockDeliveryPlatformAdapter` is built **first**, so the whole workflow is testable
without production credentials. Per D9, production Uber Eats or PickMe support is
not claimed until official access, documentation, testing, and certification are
complete.

The repository currently has **no** webhook infrastructure at all — no inbound
public POST surface, no signature verification, no replay protection, no raw-event
store. Phase 10 starts from zero.
