# Database Model

Local PostgreSQL schema, managed with Prisma (`packages/database`). This database holds the
POS's operational data plus a cache of QBO products and customers. **QuickBooks Online remains
the source of truth** for catalog, inventory, prices, and accounting.

> The full schema now lives in `packages/database/prisma/schema.prisma` (that file is the
> source of truth) with an initial migration under `packages/database/prisma/migrations/`.
> The core operational tables are documented below. The schema also adds multi-tenancy and
> access-control models — see **Additional models** at the end.

## Conventions

- UUID (`cuid`/`uuid`) primary keys.
- `createdAt` / `updatedAt` timestamps on every table.
- Cached QBO entities store the QBO id (`qboId`) and a `syncedAt` marker.
- Monetary values stored as `Decimal(12, 2)`; quantities as `Decimal(12, 3)`.
- Enums mirror `packages/shared`: `UserRole`, `SaleStatus`, `SaleType`, `SyncStatus`.

## Entity overview

```
User ─┐
      ├─< Sale >─┬─< SaleItem >── Product (cache)
Customer ────────┘        │
                          ├─< Payment
                          └─< SyncLog
```

## Tables

### User

PIN-based staff accounts.

| Column      | Type      | Notes                                         |
| ----------- | --------- | --------------------------------------------- |
| id          | uuid PK   |                                               |
| name        | string    |                                               |
| pinHash     | string    | Hashed PIN (never stored in plaintext)        |
| role        | UserRole  | `CASHIER` \| `MANAGER` \| `ADMIN` \| `OWNER` \| `ACCOUNTANT` \| `SALESPERSON` |
| isActive    | boolean   | default `true`                                |
| createdAt   | datetime  |                                               |
| updatedAt   | datetime  |                                               |

### Product (QBO cache)

Read-mostly cache of QBO items. Refreshed by the inbound sync; the POS does not edit these.

| Column        | Type          | Notes                                          |
| ------------- | ------------- | ---------------------------------------------- |
| id            | uuid PK       |                                                |
| qboId         | string        | QBO Item id — **unique**                       |
| sku           | string?       | indexed for search                             |
| barcode       | string?       | **unique**, indexed for barcode lookup         |
| name          | string        | indexed for search                             |
| price         | Decimal(12,2) | unit price from QBO                             |
| quantityOnHand| Decimal(12,3) | last-known QOH from QBO                         |
| isActive      | boolean       |                                                |
| syncedAt      | datetime      | when this row was last pulled from QBO         |
| createdAt     | datetime      |                                                |
| updatedAt     | datetime      |                                                |

Indexes: `@unique(qboId)`, `@unique(barcode)`, `@index(name)`, `@index(sku)`.

### Customer (QBO cache)

| Column    | Type     | Notes                             |
| --------- | -------- | --------------------------------- |
| id        | uuid PK  |                                   |
| qboId     | string   | QBO Customer id — **unique**      |
| name      | string   | indexed                           |
| email     | string?  |                                   |
| phone     | string?  |                                   |
| syncedAt  | datetime |                                   |
| createdAt | datetime |                                   |
| updatedAt | datetime |                                   |

### Sale

One completed (or in-progress) transaction.

| Column        | Type          | Notes                                                          |
| ------------- | ------------- | -------------------------------------------------------------- |
| id            | uuid PK       |                                                                |
| number        | string        | human-readable sale number — **unique**                        |
| status        | SaleStatus    | `DRAFT` \| `COMPLETED` \| `VOIDED` \| `REFUNDED`               |
| type          | SaleType      | `RECEIPT` (fully paid) \| `INVOICE` (partial/credit)          |
| cashierId     | uuid FK       | → User                                                          |
| customerId    | uuid FK?      | → Customer (required when `type = INVOICE`)                    |
| subtotal      | Decimal(12,2) | sum of line net amounts before tax                             |
| discountTotal | Decimal(12,2) | sum of line discounts                                          |
| taxTotal      | Decimal(12,2) |                                                                |
| total         | Decimal(12,2) | grand total                                                    |
| amountPaid    | Decimal(12,2) | sum of payments; `< total` ⇒ INVOICE, `>= total` ⇒ RECEIPT    |
| qboId         | string?       | id of the created QBO SalesReceipt/Invoice — **unique**       |
| syncStatus    | SyncStatus    | `PENDING` \| `SYNCING` \| `SYNCED` \| `FAILED`                 |
| completedAt   | datetime?     | Invoice date — user-selectable at completion, defaults to now, never future. Printed on documents, filed in QBO, and the column reports/dashboards filter on. Indexed. |
| creditSettledAt | datetime?   | When the customer's credit account was cleared, covering this invoice. Credit is settled per ACCOUNT: this records the moment **without** claiming money was tendered against this invoice, so paidAmount/balanceAmount stay true for the printed bill, the refund guard and QuickBooks. |
| paymentDueDate | datetime?    | When the balance is expected. Required at completion when the sale leaves a balance, forbidden when it does not — so **null means nothing is owed**, which is what lets the sales list leave the Due column blank rather than invent a date. Stored as the end of the chosen day in the shop's timezone; pushed to QBO as the Invoice `DueDate`. |
| createdAt     | datetime      |                                                                |
| updatedAt     | datetime      |                                                                |

Indexes: `@unique(number)`, `@unique(qboId)`, `@index(syncStatus)`, `@index(cashierId)`,
`@index(createdAt)`, `@index(tenantId, paymentDueDate)` — the overdue filter asks for "due
before today and still owing", which is a tenant-scoped range scan over the due date.

There is no stored "amount outstanding per customer": it is derived on read by summing
`balanceAmount` over the customer's COMPLETED, unsettled sales. One source of truth means the
credit-limit guard, the customers list's available-credit column, and the dashboard's
receivable total cannot drift apart, and recording a payment updates all three at once.

### SaleItem

A cart line. Discounts are **product-wise** and captured here.

| Column          | Type          | Notes                                                     |
| --------------- | ------------- | --------------------------------------------------------- |
| id              | uuid PK       |                                                           |
| saleId          | uuid FK       | → Sale (cascade delete)                                   |
| productId       | uuid FK       | → Product                                                 |
| nameSnapshot    | string        | product name at time of sale                              |
| unitPrice       | Decimal(12,2) | price at time of sale                                     |
| quantity        | Decimal(12,3) |                                                           |
| discountType    | enum?         | `PERCENT` \| `FIXED` (null = no discount)                 |
| discountValue   | Decimal(12,2) | percent or amount                                         |
| discountApprovedBy | uuid FK?   | → User (manager) when discount exceeded threshold         |
| lineTotal       | Decimal(12,2) | `(unitPrice * quantity) - discount`                       |

Index: `@index(saleId)`.

### Payment

One or more payments against a sale.

| Column    | Type          | Notes                                    |
| --------- | ------------- | ---------------------------------------- |
| id        | uuid PK       |                                          |
| saleId    | uuid FK?      | → Sale. Set on money tendered at the till; null on an account payment |
| customerId | uuid FK?     | → Customer. Set on a payment against the credit ACCOUNT. Exactly one of saleId/customerId is set — a CHECK constraint enforces it |
| settledAt | datetime?     | when this account payment was consumed by clearing the balance; null while it still works against an open one |
| method    | enum          | `CASH` \| `CARD`                          |
| amount    | Decimal(12,2) |                                          |
| reference | string?       | cheque number, transfer id, receipt no   |
| receivedByUserId | uuid FK | → User who took the money                |
| qboId     | string?       | QBO Payment id (for INVOICE sales)       |
| createdAt | datetime      | when the money came in — a settlement recorded weeks after the sale keeps its own timestamp, which is what the sale detail and the "last payment" column report |

Index: `@index(saleId)`.

### SyncLog

Append-only record of every sync attempt (inbound and outbound).

| Column      | Type       | Notes                                                       |
| ----------- | ---------- | ----------------------------------------------------------- |
| id          | uuid PK    |                                                             |
| entityType  | enum       | `PRODUCT` \| `CUSTOMER` \| `SALE` \| `PAYMENT`              |
| entityId    | string     | local id of the affected row                                |
| direction   | enum       | `INBOUND` (QBO→POS) \| `OUTBOUND` (POS→QBO)                 |
| status      | SyncStatus | `PENDING` \| `SYNCING` \| `SYNCED` \| `FAILED`             |
| attempt     | int        | retry counter                                               |
| error       | string?    | error message on failure                                    |
| createdAt   | datetime   |                                                             |

Indexes: `@index(entityType, entityId)`, `@index(status)`, `@index(createdAt)`.

## Sync-state lifecycle

```
Sale created  ──▶  syncStatus = PENDING
job picks up  ──▶  SYNCING   (+ SyncLog attempt=n, SYNCING)
QBO success   ──▶  SYNCED    (Sale.qboId set; SyncLog SYNCED)
QBO error     ──▶  FAILED    (SyncLog FAILED + error) ──▶ retry ──▶ SYNCING …
```

See [quickbooks-integration.md](./quickbooks-integration.md) for how each entity maps to QBO
and how idempotency keys prevent duplicates on retry.

## Additional models

The implemented schema is multi-tenant and adds access-control and richer sync models beyond
the core tables above. Field-level detail lives in `packages/database/prisma/schema.prisma`.

| Model                  | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `Tenant`               | Top-level account; every operational row is scoped to a tenant.         |
| `Branch`               | A store location within a tenant.                                       |
| `Register`             | A POS terminal within a branch.                                         |
| `Role` / `Permission`  | Custom RBAC (many-to-many) on top of the built-in `UserRole` enum.      |
| `ProductCategory`      | Self-nesting product categories (cached from QuickBooks).               |
| `Discount`             | Reusable discount definitions with optional approval thresholds.        |
| `Receipt`              | Printed-receipt record per sale (number, print count, content).         |
| `SyncJob`              | A unit of sync work (type, direction, attempts, status) with `SyncLog`s.|
| `QuickBooksConnection` | Per-tenant OAuth tokens, realm id, and environment.                     |
| `QuickBooksMapping`    | **Unused / legacy — never written.** Entity linkage lives on the entities themselves: `Product.quickbooksItemId`, `Customer.quickbooksCustomerId`, `Supplier.quickbooksVendorId`. |
| `AuditLog`             | Append-only record of user/system actions.                              |

### Dates and times

Every `DateTime` column is Postgres `timestamp(3)` and holds a **UTC instant** — Prisma serialises a
JS `Date` as its UTC wall clock and re-inflates it the same way, so the instant round-trips regardless
of the Node or Postgres session timezone. The API and database containers additionally pin `TZ=UTC`
(and `PGTZ=UTC`) so this is an enforced invariant rather than a default.

Timezone conversion is a **display** concern only: screens render in the viewer's browser zone,
documents in the shop's `settings.timezone`. No column stores a bare calendar day.

Every business carries an explicit `timezone` in `TenantSettings.data`, defaulting to `Asia/Colombo`
(Sri Lanka). It is written when a tenant is provisioned, and a migration backfilled it for businesses
that pre-date the field — so a shop's zone is a stored decision rather than whatever the code default
happens to be.

### Enums

`UserRole`, `PaymentMethod`, `PaymentStatus`, `SyncStatus`, `DiscountType`,
`QuickBooksDocumentType`, `SaleStatus` — mirrored in `packages/shared` where the app needs them.
