# QuickBooks Online Integration

How the POS connects to **QuickBooks Online (QBO)**, pulls catalog data, and pushes sales.

> Not implemented yet — this is the integration design. Code will live in a `quickbooks`
> feature module inside `apps/api`.

## 1. Principles

- QBO = source of truth for products, inventory, prices, accounting, reports.
- POS = cashier sales workflow with a local product/customer cache.
- The POS never edits stock or prices in QBO. Inventory decrements happen in QBO as a
  side effect of the Sales Receipts / Invoices the POS creates.
- If sync fails, the sale stays saved locally and is retried. No sale is lost.

## 2. Authentication (OAuth 2.0)

- Standard QBO OAuth 2.0 Authorization Code flow.
- Admin connects the company once via `GET /v1/quickbooks/connect` → QBO consent →
  `GET /v1/quickbooks/callback`.
- Store, encrypted at rest: `access_token`, `refresh_token`, `realmId` (company id),
  and token expiry.
- Access tokens are short-lived; **refresh proactively** before expiry and on any `401`.
- Config via environment variables (see `.env.example`):
  `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT` (`sandbox` | `production`).
- Build against the **sandbox** company first, then flip `QBO_ENVIRONMENT` for production.

## 3. Direction of sync

**Inbound — QBO → POS (cache refresh)**

| QBO entity | Cached as        | Fields used                       |
| ---------- | ---------------- | --------------------------------- |
| Item       | `Product`        | id, name, sku, price, qtyOnHand   |
| Customer   | `Customer`       | id, name, email, phone            |

- Runs on a schedule (e.g. every N minutes) and on demand from the admin UI.
- Upsert by `qboId`. Use QBO's `CDC` (change data capture) / `Metadata.LastUpdatedTime`
  to pull only what changed since the last sync where possible.

**Outbound — POS → QBO (per completed sale)**

| POS record            | QBO document                       |
| --------------------- | ---------------------------------- |
| Sale (type RECEIPT)   | **SalesReceipt**                   |
| Sale (type INVOICE)   | **Invoice** + **Payment**          |
| Payment               | **Payment** (applied to the Invoice) |

## 4. Transaction mapping

| POS event         | Rule                              | QBO result                                   |
| ----------------- | --------------------------------- | -------------------------------------------- |
| Fully paid sale   | `amountPaid >= total`             | Create **SalesReceipt** with the line items  |
| Partial / credit  | `amountPaid < total`             | Create **Invoice** (full amount), then a **Payment** for `amountPaid` applied to it |
| Return / exchange | *(phase 2)*                       | Refund Receipt / Credit Memo *(later)*       |

Line items map to QBO `SalesItemLineDetail` using each product's QBO `Item` id, the sale-time
unit price, quantity, and the product-wise discount (as a line discount or a discount line,
per QBO's model). A customer reference is required on Invoices.

### 4.1 Customer references

`CustomerRef` is resolved from **`Customer.quickbooksCustomerId`** — the same field the inbound
pull populates, mirroring how products resolve through `Product.quickbooksItemId`. The
`QuickBooksMapping` table is **not** consulted; it has never been written and is legacy.

It is **required** on an Invoice, a Credit Memo and a Payment, and **optional** on a Sales
Receipt or Refund Receipt (a walk-in cash sale legitimately has no customer).

A customer created in the POS has no link yet, so one is established before the document is
built:

1. If `quickbooksCustomerId` is already set, use it.
2. Otherwise look for an **active** QuickBooks customer with the same `DisplayName` and adopt it,
   rather than creating a second record for the same person.
3. Otherwise create the customer in QuickBooks and store the returned id.

The write is idempotent, which matters because the sync queue retries: the id is claimed
write-once (`quickbooksCustomerId: null` compare-and-set), so two sales syncing concurrently for
the same new customer end up sharing one QuickBooks record. QuickBooks enforces `DisplayName`
uniqueness across customers, vendors and employees; a clash (error 6240) is recovered by adopting
the existing customer, and reported plainly when the name belongs to a vendor or a deactivated
record instead.

`openingBalance` is deliberately never pushed — QuickBooks owns the live A/R balance, and sending
one would post an opening-balance journal entry on top of the invoices the POS already sends.

Every document carries `TxnDate` — the POS **invoice date**, sent as a bare `YYYY-MM-DD`
calendar date derived in server-local time, so the day filed in QuickBooks is the day picked
at the till. A backdated sale is therefore filed in the period it belongs to rather than the
day it was keyed in. The linked Payment on a partial/credit sale carries the same `TxnDate`,
so a payment is never dated ahead of the invoice it settles.

> **Open question (accountant):** if the QuickBooks company has a books-closing date, a
> transaction dated before it is rejected. The POS does not currently pre-check that date —
> such a sale saves locally and surfaces as a failed sync in the sync log.

## 5. Idempotency (no duplicates on retry)

Retries must never create a second QBO document for the same sale.

- Generate a stable **idempotency key** per outbound entity (e.g. the local `Sale.id`).
- Before creating a document, check whether `Sale.qboId` is already set — if so, skip creation.
- On create success, persist the returned QBO id (`Sale.qboId`, `Payment.qboId`) **in the same
  transaction** as marking the sync `SYNCED`.
- If a create call times out with an unknown result, **query QBO** (by `DocNumber` / private
  note carrying the idempotency key) before re-creating.

## 6. Sync jobs, status & retry

- Each outbound sale is a job: `PENDING → SYNCING → SYNCED | FAILED`.
- Failures retry with exponential backoff up to a max attempt count, then rest in `FAILED`
  for **manual retry** from the sync log UI.
- Every attempt appends a `SyncLog` row: entity type, direction, status, attempt #, error.
- The POS surfaces per-sale sync status in sales history and a dedicated sync-log screen.

## 7. Error handling

| Failure                         | Handling                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| Token expired (`401`)           | Refresh token, retry the call once                             |
| Rate limited (`429`)            | Back off and retry per `Retry-After`                           |
| Validation error (`400`)        | Mark `FAILED`, log the QBO fault, surface for manual review    |
| Network / `5xx` / timeout       | Retry with backoff; verify idempotently before re-creating     |
| Stale price / item not found    | Flag the sale; trigger a catalog re-sync                        |

## 8. Open questions

- Tax: rely on QBO automated sales tax, or send tax lines explicitly? (Confirm with QBO config.)
- Discounts: represent as per-line discount vs. a discount line item — depends on the QBO
  company's preferences (`Preferences.SalesFormsPrefs`).
- Payment methods & deposit accounts: which QBO accounts back CASH vs. CARD payments.
