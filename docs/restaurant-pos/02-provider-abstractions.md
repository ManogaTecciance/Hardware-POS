# Provider abstractions

Status: **inventory and accounting ports implemented** in Phase 1 Slice 5 / 5.5
(decisions D24, D25). They are deliberately **inert**: `ProvidersModule` is not
imported into `AppModule`, and no sales, returns, or products call site uses a
provider yet — adoption is Slice 6. Printing is Phase 6. Delivery is Phase 10.

Where the shipped ports differ from this document's original specification, the
"As implemented" sections below are authoritative.

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
  readonly mode: ProviderInventoryMode;
  readonly name: string;

  getAvailability(ctx: ProviderContext, productIds: string[]): Promise<AvailabilityMap>;

  reduceStock  (tx: Prisma.TransactionClient, ctx: ProviderContext, lines: StockLine[]): Promise<void>;
  restoreStock (tx: Prisma.TransactionClient, ctx: ProviderContext, lines: StockLine[]): Promise<void>;
  adjustStock  (tx: Prisma.TransactionClient, ctx: ProviderContext, adjustments: StockAdjustment[]): Promise<void>;

  synchronize(ctx: ProviderContext): Promise<ProviderSyncOutcome>;
}
```

**As implemented — `reserveStock` was dropped.** This document originally proposed it.
Inspection during Slice 5 found no reservation anywhere in the repository: no
held-stock column, no reservation table, no expiry. It was a speculative interface
for a feature that does not exist, and modelling it would have invented a contract
nobody could check against real behaviour.

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
  readonly name: string;

  resolveSaleDocumentType  (sale: SaleFinancialShape):    DocumentTypeDecision<QuickBooksDocumentType>;
  resolveReturnDocumentType(input: ReturnFinancialShape): DocumentTypeDecision<QuickBooksReturnDocumentType>;

  postSale(
    tx: Prisma.TransactionClient, ctx: ProviderContext,
    saleId: string, documentType: QuickBooksDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksDocumentType>>;

  postReturn(
    tx: Prisma.TransactionClient, ctx: ProviderContext,
    returnId: string, documentType: QuickBooksReturnDocumentType | null,
  ): Promise<AccountingSubmissionResult<QuickBooksReturnDocumentType>>;

  synchronize(ctx: ProviderContext): Promise<ProviderSyncOutcome>;
}
```

### `AccountingSubmissionResult` (decision D25)

The result is a discriminated union, never `void` and never the ambiguous pair
`{ markSynced: true, quickbooksDocumentType: null }` — that combination says a
synchronisation succeeded *and* that there is no document, so a caller cannot tell
"posted to QuickBooks" from "no accounting system configured", and the
safe-looking reading is the wrong one.

```ts
export type AccountingSubmissionResult<T extends string = string> =
  | { disposition: 'QUEUED';       provider: 'QUICKBOOKS'; externalDocumentType: T }
  | { disposition: 'NOT_REQUIRED'; provider: 'NONE';       externalDocumentType: null };
```

`NOT_REQUIRED` means the transaction completed **locally and completely** and
nothing needed synchronising. It is a success, not a degraded outcome. It carries no
secret and no provider internals — three fields, and no realm id, token, or
connection state.

Application-level only: **no Prisma enum and no migration.** The persisted columns
are unchanged, and a `NOT_REQUIRED` sale stores `null` in the already-nullable
`Sale.quickbooksDocumentType`.

`resolveSaleDocumentType` returns `requiresCustomer` rather than throwing, so the
caller keeps raising its existing user-facing error with its existing wording. That
is what makes Slice 6 a pure extraction rather than a change in error behaviour.

### `postPayment` is deliberately absent (decision D26)

**Do not add `postPayment()` to `AccountingProvider`** until an approved, implemented
standalone-payment workflow exists.

`PaymentsService.create` currently throws `NotImplementedException`. Payments are
created inside the sale transaction and receive their `quickbooksPaymentId` as part
of the sale push, so there is no separate payment post to abstract. Restaurant split
and mixed payments will initially be local `Payment` records inside an order/sale
completion transaction, which needs no accounting port method either.

Add a separate accounting payment operation later, only for a workflow that actually
exists — paying an existing credit invoice later, posting a payment separately from
sale creation, or applying a settlement against a previously created invoice. Until
then it would be a speculative provider operation.

Likewise **`postCreditNote` was dropped**: a credit memo is not a different
operation from a refund receipt, it is a different *document type* for the same
return push, already expressed by `QuickBooksReturnDocumentType`. Two methods would
imply two code paths that do not exist.

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
