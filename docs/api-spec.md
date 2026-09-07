# API Specification

REST API served by `apps/api` (NestJS). All routes are versioned under **`/v1`**.

> Draft contract — endpoints are not implemented yet. Shapes align with the models in
> [database-model.md](./database-model.md) and the shared enums in `packages/shared`.

## Conventions

- Base URL: `http://localhost:4000/v1` (dev). Configurable via `API_PORT` / `NEXT_PUBLIC_API_URL`.
- JSON request/response bodies. Money as string decimals (e.g. `"12.50"`).
- Success envelope: `{ "data": ... }`. Error envelope: `{ "statusCode", "message", "error" }`.
- Auth: cashier logs in with a PIN and receives a session token (JWT/bearer) sent as
  `Authorization: Bearer <token>` on subsequent calls.
- Tenant context: until auth is wired, tenant-scoped endpoints require an `x-tenant-id`
  header (a temporary placeholder; the tenant will later be derived from the session token).
- Not-yet-implemented write/QuickBooks flows return `501 Not Implemented` in the standard
  error envelope.
- Pagination: `?page=1&pageSize=25` → `{ "data": { "items": [], "total", "page", "pageSize" } }`.

## Health

```
GET /v1/health
200 → { "status": "ok", "service": "hardware-pos-api", "timestamp": "..." }
```

## Auth

Two login methods issue the same bearer JWT (payload: `sub`, `tenantId`, `role`). Send it as
`Authorization: Bearer <token>` on all other calls; the tenant is taken from the token.

```
POST /v1/auth/login                   # email + password (owner / admin / salesperson / accountant)
body:  { "email": "owner@hardwarepos.test", "password": "password123" }
200 →  { "data": { "token": "...", "user": { "id", "tenantId", "name", "email", "role" } } }
401 →  invalid email or password

POST /v1/auth/pin-login               # PIN (cashier / manager); requires x-tenant-id header
headers: x-tenant-id: <tenantId>
body:  { "pin": "1111" }
200 →  { "data": { "token": "...", "user": { ... } } }
401 →  invalid PIN

GET  /v1/auth/me                      # current user + effective permissions
200 →  { "data": { "id", "tenantId", "name", "email", "role", "branchId", "permissions": [] } }
```

## Discounts (manual, product-wise)

Each sale line may carry a manual discount (`PERCENTAGE` or `FIXED`), a `discountReason`, and —
when it exceeds the operator's limit — an approver. Per-role limits (percentage of the line):

| Role                         | Max discount without approval |
| ---------------------------- | ----------------------------- |
| Cashier / Accountant         | 0%                            |
| Manager                      | 15%                           |
| Owner / Admin / Salesperson  | unlimited                     |

If a line's discount exceeds the acting user's limit, sale create returns **403** with a
machine-readable body so the front-end can pop a manager-PIN modal:

```
403 → { "statusCode": 403, "error": "DiscountApprovalRequired", "requiresApproval": true,
        "productId": "...", "requiredPercent": 20, "message": "..." }
```

The cashier then gets an approval token and retries with it on that line:

```
POST /v1/discounts/approve            # cashier submits a manager's PIN
body:  { "managerPin": "2222", "productId": "...", "discountType": "PERCENTAGE",
         "discountValue": 15, "reason": "loyal customer" }
200 →  { "data": { "approved": true,  "approvedByUserId": "...", "approvalToken": "<jwt, 15m>" } }
200 →  { "data": { "approved": false, "approvedByUserId": "...|null", "approvalToken": null,
                   "reason": "Discount exceeds this approver’s limit" } }
401 →  invalid manager PIN
```

The token binds tenant + product + discount type/value; attach it as `approvalToken` on the
sale item. The approver's own limit is re-checked against the real line at completion (so a
manager token cannot cover a discount beyond 15%). Completing a draft reuses the approver
already recorded on the draft line — no re-approval needed.

### Dates and times

Every datetime is **stored and transmitted as a UTC instant** and crosses the wire as an ISO-8601
string. Nothing is persisted as a bare calendar day. Conversion to a timezone happens only at the
moment a value is shown, and which zone depends on what is being shown:

| Surface | Timezone |
| ------- | -------- |
| On screen (sales list, dashboard, sync times) | the **viewer's own** browser timezone |
| Documents — invoice, receipt, PDF/XLSX report, emailed or shared copies | the **shop's** timezone, from `settings.timezone` |

Documents are pinned to the shop's zone deliberately: an invoice is a business record, so a reprint —
or the customer's emailed copy opened in another country — must carry the same date as the original.
`settings.timezone` is an IANA name (default `Asia/Colombo`) settable via `PUT /v1/settings`; an
unknown zone is rejected with 400. Any zone the runtime knows is accepted, and the Settings picker
offers the full IANA set grouped by region.

The `saleDate` on `POST /v1/sales/complete` is likewise a calendar day **in the shop's timezone**, and
"not in the future" is judged against the shop's current day.

Business windows are cut on the shop's clock too. Dashboard ranges — "today", the default 7-day
window, the per-day series buckets and a cashier's shift — run from one shop midnight to the next,
not from the server's or the database session's. For a Colombo shop on a UTC host that is the
difference between a day running 00:00–00:00 and one running 05:30–05:30.

### Roles & permissions

Roles: `OWNER`, `ADMIN`, `SALESPERSON`, `MANAGER`, `CASHIER`, `ACCOUNTANT`. Routes are
protected by a global JWT guard plus role/permission guards. `SALESPERSON` is an
owner-equivalent role — it carries exactly the `OWNER` permission set, the same
unlimited discount ceiling, and the same admin-level overrides. Summary of enforced
access:

| Capability                         | Roles                                       |
| ---------------------------------- | ------------------------------------------- |
| Create sales / take payments       | Cashier, Manager, Owner, Admin, Salesperson |
| Approve high discounts             | Manager, Owner, Admin, Salesperson          |
| View sync logs & QuickBooks status | Accountant, Owner, Admin, Salesperson       |
| Connect QuickBooks / manage users / settings | Owner, Admin, Salesperson         |
| Everything                         | Owner, Admin, Salesperson                   |

Unauthenticated → `401`; authenticated but not permitted → `403`.

## Products (read-only cache)

QuickBooks Online is the inventory master; products are a **read-only local cache**. There are
no create/update/delete product endpoints — the POS never edits stock. The cache is refreshed
only via sync (mock sync below, real QuickBooks sync later).

```
GET /v1/products?search=hammer&page=1&pageSize=25          # free-text (name/sku/barcode)
200 → { "data": { "items": [ { "id", "quickbooksItemId", "sku", "barcode", "name", "unitType", "unitPrice", "quantityOnHand", "syncStatus" } ], "total", "page", "pageSize" } }

GET /v1/products/search?name=&sku=&barcode=&categoryId=&isActive=true   # structured filters (AND)
200 → paginated products

GET /v1/products/barcode/{barcode}
200 → { "data": { "id", "name", "unitPrice", "quantityOnHand", ... } }
404 → unknown barcode

GET /v1/products/{id}
200 → single product   |   404 → not found

POST /v1/products/sync/mock            # simulate a QuickBooks catalog pull (owner-level roles only)
200 → { "data": { "created", "updated", "total", "categories" } }
403 → lacks quickbooks:manage

GET /v1/categories                     # product categories with product counts
200 → { "data": [ { "id", "name", "parentId", "isActive", "_count": { "products" } } ] }
```

All product/category read routes require `product:read`; every role has it.

## Customers (read-only cache)

```
GET /v1/customers?query=acme
200 → { "data": { "items": [ { "id", "qboId", "name", "email", "phone" } ], ... } }

GET /v1/customers/{id}/credit          # customer:read — live credit position
200 → { "creditAllowed", "creditLimit", "outstanding", "available" }
404 → no such customer in this tenant
# Served from the same CreditService the sale-completion guard uses, so the figure a
#   cashier is shown is the figure they are held to. `creditLimit: null` means no limit
#   is configured, i.e. unlimited — NOT zero. `available` is unclamped and CAN be
#   negative (a limit lowered after the fact); clamp it at zero for display, as the
#   server does in its own error message.
# The POS payment page re-reads this as the order changes, so a cashier sees "over the
#   credit limit" while adjusting quantities rather than when they press Complete
#   Payment. It is advisory: the server re-checks on completion and decides.

GET /v1/customers?page=1&pageSize=20&hasOutstandingCredit=true
200 → paginated customers, each row carrying its credit position:
      { ..., "creditLimit", "outstandingCredit", "availableCredit" }
# outstandingCredit: unpaid balance summed across the customer's COMPLETED,
#   unsettled sales — the same figure the credit-limit guard enforces against.
# availableCredit: creditLimit − outstandingCredit, or **null** when no limit is
#   configured. Null is not zero: "no limit set" and "no credit left" are
#   different answers and clients must not conflate them.
# hasOutstandingCredit=true: only customers who currently owe something (the
#   dashboard's receivable card deep-links here).
```

## Sales

All sale routes derive tenant + cashier from the JWT. Create routes require `sale:create`,
reads require `sale:read`. The POS never reduces inventory — QuickBooks is the master; local
stock is refreshed by product sync after a QuickBooks push succeeds.

```
POST /v1/sales/draft                   # build a DRAFT sale (totals computed, nothing charged)
body: { "branchId", "registerId?", "customerId?",
        "items": [ { "productId", "quantity", "unitPrice?",
                     "discountType?": "PERCENTAGE|FIXED", "discountValue?",
                     "discountBasis?": "LINE|UNIT",
                     "discountReason?", "approvalToken?" } ] }
200 → { "data": <sale with items, status DRAFT, syncStatus NOT_SYNCED> }

POST /v1/sales/complete                # complete a draft (saleId) OR a full cart in one shot
body (draft):    { "saleId", "customerId?", "saleDate?", "paymentDueDate?", "payments": [ { "method", "amount", "reference?" } ] }
body (one-shot): { "branchId", "registerId?", "customerId?", "saleDate?", "paymentDueDate?", "items": [ ... ], "payments": [ ... ] }
201 → { "data": <sale status COMPLETED, paymentStatus, quickbooksDocumentType, syncStatus PENDING> }
400 → validation error (empty cart, price changed, insufficient stock,
       unapproved high discount, credit/partial sale without a customer,
       a sale date in the future, a missing payment due date on a sale that
       leaves a balance, or a payment due date on a fully paid sale)

# saleDate: the invoice date, as a YYYY-MM-DD calendar date. Omitted = now. It is
#   interpreted in the SERVER's timezone and stored as the sale's `completedAt`, which
#   is the date printed on the invoice/receipt, filed in QuickBooks, and used to place
#   the sale in the sales history and dashboard. A future date is rejected; stock still
#   moves at completion time, not on the chosen date.
# Completion pipeline: resolve the sale date → validate items → validate prices vs cache → check stock →
#   subtotal → product-wise discounts → tax (if rate > 0) → total → save sale,
#   items, payments → enqueue an outbound QuickBooks sync job.
# discountBasis: what a FIXED line discount is measured against. LINE (the default,
#   and the meaning of every sale before this) takes the amount off once; UNIT takes
#   it off every unit — value × quantity. Rejected on a PERCENTAGE, which is already
#   the same figure per unit and per line. The amount is always clamped to the line,
#   so a per-unit discount larger than the unit price floors the line at zero.
#   Order-level discounts have no units and are always whole-cart.
#   Quotation lines carry the same field, and it is carried into the sale on
#   conversion — a quotation is never re-priced by becoming an invoice.
#   The basis is bound into the discount-approval token: an approval for an amount
#   off the line cannot be spent on the same amount off every unit.
# Transaction type: paidAmount >= total → SALES_RECEIPT; otherwise INVOICE (customer required).
# Payments: full, partial, or none (full credit) are all supported.
# paymentDueDate: when the balance is expected, as a YYYY-MM-DD calendar date.
#   REQUIRED whenever the payments leave a balance, and REJECTED on a fully paid
#   sale, which owes nothing. It may not fall before the invoice date (a backdated
#   sale may therefore be recorded already overdue). Interpreted in the shop's
#   timezone and stored as the end of that day; pushed to QuickBooks as the
#   Invoice `DueDate`.

GET  /v1/sales?page=1&pageSize=25&syncStatus=FAILED
200 → paginated sales history (syncStatus per sale)
# Filters: search, paymentStatus, syncStatus, dateFrom, dateTo, overdue=true.
#   paymentStatus=UNPAID means "still on credit": wholly unpaid or part-paid, and
#   never one the customer's account has since cleared. PAID means the opposite —
#   paid at the till, OR covered by an account settlement. PARTIAL on its own still
#   narrows to exactly those, for a caller that wants them.
# Each row carries `creditSettledAt`: when set, the sale reads as Paid because the
#   customer cleared their account, even though nothing was tendered against it.
#   overdue=true keeps only COMPLETED sales whose paymentDueDate has passed and
#   which still owe money. GET /v1/sales/report accepts the same filters, so an
#   export always covers exactly the sales the screen was showing.
# Each row carries `paymentDueDate` (null when nothing is owed) and
#   `lastPaymentAt` (when money was last received against the sale, null if never).

POST /v1/sales/{id}/marked-paid        # payment:create
body: { "marked": true | false }
200 → the sale
400 → not completed, no customer, already paid, or it is the LAST uncovered invoice
       on an account that still owes
# Ticking a credit invoice off is BOOKKEEPING: it records who accounted for it and
#   when (`markedPaidAt`, `markedPaidByName`) and moves no money — balanceAmount,
#   paymentStatus and the credit aggregation are untouched, and the customer still
#   owes what the account says. Marking every invoice is what would make an account
#   read as dealt with, so the final tick must be earned by recorded payments; those
#   payments settle it anyway, via creditSettledAt, without anyone clicking.
# Clearing an account is itself an act of accounting for it: every invoice that
#   still had a tick available is stamped with the settlement's own timestamp and
#   the user who recorded the payment, so the customer page reads the same whether
#   a person ticked an invoice off or the payment did. An invoice someone already
#   ticked keeps THEIR name and time — the settlement does not take the credit.

GET  /v1/sales?customerId={id}        # a customer's invoices, for their page

GET  /v1/sales/{id}
200 → full sale with items, payments, customer

POST /v1/sales/{id}/sync               # push the sale to QuickBooks (mock for now)
200 → sale marked SYNCED with a mock quickbooksDocumentId; payments get mock ids;
      the sync job closes and a SyncLog entry is written
400 → sale is not COMPLETED
```

### Payment method on a document

A bill, PDF or thermal receipt states its method with the shared rule in
`documentPaymentMethods` (`packages/shared`): while a balance remains the sale is running
on credit, so **Credit** is listed — alongside anything already tendered, since a customer
who paid half in cash did use cash. Once the sale is settled the list is simply what they
paid with, so a bill reprinted after settlement reads `Bank transfer` rather than `Credit`.

`Credit` is a render-time label, not a `PaymentMethod`: nothing is tendered on credit, so
there is no enum member and nothing is stored.

## Payments received

Credit is an **account** balance, not a per-invoice one. Money received later is recorded
against the CUSTOMER and is never applied to a single sale. Requires `payment:create`.

```
POST /v1/payments
body: { "customerId", "method", "amount", "reference?" }
201 → { "data": { "payment", "outstanding", "salesSettled" } }
400 → amount <= 0, more than the account owes, or the account owes nothing
404 → no such customer in this tenant

GET  /v1/payments?customerId={id}      # the customer's credit history, newest first
GET  /v1/payments?saleId={id}          # what was tendered at the till for one sale
GET  /v1/payments/{id}
# One filter is required — without it this would return every payment in the tenant.
```

The rule, in one line: **while the account owes anything every credit sale stays outstanding,
and the moment it reaches zero they are all settled together.** A part payment therefore
settles no invoice at all — not even the oldest — and a sale rung up after a settlement
starts the next balance rather than joining the one already closed.

Settlement is recorded on `Sale.creditSettledAt`, NOT by rewriting `paidAmount` /
`balanceAmount` / `paymentStatus`. Those stay true to what was tendered against that invoice
at the till, because the printed bill, the refund guard and QuickBooks all read them; a swept
sale would otherwise claim money it never took. The payments that closed a balance are
retired with `Payment.settledAt`, so the next cycle starts from zero instead of subtracting
them forever.

```
account outstanding = SUM(balanceAmount over COMPLETED, still-unpaid, unsettled sales)
                    - SUM(account payments not yet consumed by a settlement)
```

Recomputed **inside** the write transaction, so two people settling the same account at once
cannot between them overpay it. Money paid on account reduces the customer's outstanding —
and the dashboard receivable — the moment it is taken, even though no invoice is settled yet.

> `TODO(accountant)`: account payments are not yet pushed to QuickBooks against the customer's
> open invoices, so QuickBooks still shows them unpaid after the customer has settled.

## Receipts & print jobs

Printing is browser-based for v1: each endpoint returns a self-contained printable HTML
document (with a Print button) inside a `PrintJob`. A hardware sale prints the **customer
receipt** by default; if any line's product has `requiresWarehousePickup = true`, a
**warehouse picking copy** (listing only the pickup items) is created alongside it.

```
POST /v1/receipts/{saleId}/customer    # customer receipt (+ auto warehouse copy if needed)
201 → { "data": { "receiptNumber", "warehousePickupRequired": bool,
                   "printJob": { "id", "type": "CUSTOMER_RECEIPT", "status", "html" },
                   "warehousePrintJob": { ... } | null } }
400 → sale not completed   |   404 → sale not found

POST /v1/receipts/{saleId}/warehouse   # (re)generate the warehouse picking copy
201 → { "data": { "id", "type": "WAREHOUSE_PICKING", "status": "PENDING", "html" } }
400 → no items on the sale require warehouse pickup

GET  /v1/receipts/sale/{saleId}        # stored customer-receipt record
GET  /v1/receipts/{id}

GET  /v1/print-jobs?saleId=&type=CUSTOMER_RECEIPT|WAREHOUSE_PICKING&status=PENDING|PRINTED|FAILED
200 → paginated print jobs (each includes its printable html)

POST /v1/print-jobs/{id}/mark-printed  # mark a job PRINTED after the browser prints it
200 → { "data": { "id", "status": "PRINTED", "printedAt" } }
```

Generating receipts / marking printed requires `sale:create`; listing/reading requires `sale:read`.

## Sync

### Sync queue & worker

Completing a sale writes a `SyncJob` row (`type = SALES_SYNC`, `status = PENDING`) **in the same
transaction** as the sale — a transactional outbox, so a sale is never lost even if QuickBooks is
down. A background **worker** polls the queue and drains it:

1. recovers jobs stuck in `SYNCING` (crash recovery) back to `PENDING`,
2. atomically **claims** due `PENDING` jobs (→ `SYNCING`, `attempts++`) — safe for concurrent workers,
3. dispatches each to a handler by `type` (`SALES_SYNC` → QuickBooks sales sync),
4. on success marks `SYNCED`; on failure **reschedules with linear backoff** until `maxAttempts`,
   then leaves it `FAILED` for a manual retry. The error message is stored on the job and logged.

The worker is a thin, swappable layer: the queue service, handler registry, and producers are the
seams to move to **BullMQ/Redis** later without touching sale completion or the handlers. Configure
via `SYNC_WORKER_ENABLED` (`false` to disable, e.g. when BullMQ takes over), `SYNC_WORKER_INTERVAL_MS`,
`SYNC_WORKER_BATCH_SIZE`, `SYNC_RETRY_BACKOFF_MS`, `SYNC_STALE_MS`.

```
GET /v1/sync/logs?entityType=SALE&status=FAILED&page=1
200 → { "data": { "items": [ { "id", "entityType", "entityId", "direction", "status", "attempt", "error", "createdAt" } ], ... } }

POST /v1/sync/sales/{id}/retry        # manual "Retry Sync": re-queue a sale's job (attempts reset,
202 → { "data": { "id", "syncStatus": "PENDING" } }   #   status → PENDING); the worker retries it

POST /v1/sync/products/refresh        # on-demand inbound catalog pull (admin)
202 → { "data": { "started": true } }
```

## QuickBooks connection (OAuth 2.0)

Real Intuit OAuth 2.0. Configure `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`,
`QUICKBOOKS_REDIRECT_URI`, `QUICKBOOKS_ENVIRONMENT`, and `TOKEN_ENCRYPTION_KEY`. Access and
refresh tokens are stored **encrypted at rest** (AES-256-GCM) and never returned to the client.

```
GET  /v1/quickbooks/connect            # owner/admin/salesperson — 302 → Intuit authorization screen
                                       # state is a signed, short-lived JWT carrying the tenant

GET  /v1/quickbooks/callback           # public redirect target from Intuit
                                       # verifies state, exchanges the code for tokens, stores
                                       # them (encrypted) + realmId + expiry, then
                                       # 302 → {WEB_ORIGIN}/quickbooks?connected=1
                                       # on failure → …/quickbooks?error=<message>

POST /v1/quickbooks/disconnect         # owner/admin/salesperson — revokes the token and removes the connection
200 → { "data": { "disconnected": true } }

GET  /v1/quickbooks/status             # quickbooks:read — never exposes tokens
200 → { "data": { "connected": true, "realmId": "...", "environment": "sandbox", "tokenExpiresAt": "..." } }
```

Access tokens are auto-refreshed (using the stored refresh token) when expired; refresh happens
server-side only and is used by the sync worker.

## QuickBooks product sync

Pulls the item catalogue from QuickBooks into the local product cache. Uses the stored access
token (refreshing it first if expired), queries `Item` records, imports **Inventory** and
**NonInventory** items (other types such as `Service` are skipped), and upserts them by
`(tenantId, quickbooksItemId)`. Mapped fields: `name`, `sku`, `description`, `unitPrice`,
`quantityOnHand`, `type`, `isActive`. Each run records an inbound `SyncLog` entry.

```
POST /v1/quickbooks/sync-products      # quickbooks:manage — requires an active connection
200 → { "data": { "created": 4, "updated": 0, "skipped": 2, "failed": 0, "total": 6 } }
404 → QuickBooks is not connected
```

## QuickBooks sales sync

Pushes a completed sale to QuickBooks. A **fully paid** sale becomes a **Sales Receipt**; a
**credit / partial** sale becomes an **Invoice**, and when any amount was paid a **Payment** is
created and linked to that invoice. The `CustomerRef` on each document is resolved from
`Customer.quickbooksCustomerId`; a customer not yet in QuickBooks is created there first (or an
existing one of the same name adopted) and the id stored, so a credit sale for a customer added at
the till syncs without manual linking. Both the document and its linked Payment carry a `TxnDate`
equal to the sale's invoice date (a bare `YYYY-MM-DD` in server-local time), so a backdated POS
sale is filed in QuickBooks on the day it happened rather than the day it was keyed in. An
Invoice additionally carries a `DueDate` taken from the sale's `paymentDueDate`, so the terms
agreed at the till are the terms QuickBooks ages the receivable against.
Sale line items reference their `quickbooksItemId` when the
product has been synced. Product-wise discounts are baked into each line's net amount (QuickBooks
has no per-line discount field) and noted in the line description — see the `TODO(accountant)`
comments where an itemised discount line or document-level discount would need confirmation.

The QuickBooks document id is stored on the sale, the QuickBooks payment id on the sale's
payments, and every attempt records a `SyncLog`. If the push fails, the sale is **kept in the POS**
and marked `FAILED` (with `syncError`) — never rolled back.

```
POST /v1/quickbooks/sync-sale/{saleId} # quickbooks:manage — sale must be COMPLETED
200 → { "data": { "saleId", "saleNumber", "status": "SYNCED"|"FAILED",
                  "quickbooksDocumentType": "SALES_RECEIPT"|"INVOICE",
                  "quickbooksDocumentId", "quickbooksPaymentId", "message" } }
404 → QuickBooks not connected / sale not found

POST /v1/quickbooks/retry/{syncLogId}  # quickbooks:manage — re-run the sale sync for a failed log
200 → same shape as sync-sale (attempt count incremented)
```

## Error codes

| Status | Meaning                                             |
| ------ | --------------------------------------------------- |
| 400    | Validation error (bad body, business-rule violation)|
| 401    | Missing/invalid session or PIN                      |
| 403    | Authenticated but not permitted (e.g. non-manager)  |
| 404    | Resource not found                                  |
| 409    | Conflict (e.g. duplicate sale number)               |
| 502    | Upstream QBO error surfaced to the caller           |
