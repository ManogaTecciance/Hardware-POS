# Integration Test Plan — Hardware POS

Scope: exercise the API **end-to-end over HTTP** against a real (disposable) PostgreSQL, asserting
the resulting DB rows. QuickBooks/Intuit is replaced by a **local HTTP stub** — never call Intuit.
The background sync worker is **disabled** (`SYNC_WORKER_ENABLED=false`) so tests drive the queue
deterministically.

Framework: Jest + Supertest against the Nest app (`Test.createTestingModule` → `app.getHttpServer()`).

## Harness / setup

1. Start a throwaway Postgres, `prisma migrate deploy`, `db:seed`.
2. Boot the Nest app with test env: `DATABASE_URL` → test DB, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
   `QUICKBOOKS_*` → the stub, `SYNC_WORKER_ENABLED=false`.
3. **Intuit stub** implements: `POST /oauth2/tokens` (token exchange/refresh),
   `GET /v3/company/{realmId}/query` (items), `POST /v3/company/{realmId}/{salesreceipt|invoice|payment}`
   (returns `{ Id }`). Add a control to force N failures for retry tests.
4. Helpers: `login(email,pw)` / `pinLogin(pin)` → bearer token; `connectQuickBooks()` runs
   connect→callback to store a connection; `asRole(role)` returns a token.

All responses are `{ data }`. IDs: `I-<area>-<n>`.

---

## 1. Login

| ID | Request | Expected |
| --- | --- | --- |
| I-01-1 | `POST /v1/auth/login` owner creds | 200/201, `data.token` + `data.user` (role OWNER, tenant tnt_dev). |
| I-01-2 | `POST /v1/auth/login` bad password | 401. |
| I-01-3 | `POST /v1/auth/pin-login` `{pin:"1111"}` + `x-tenant-id: tnt_dev` | 200, Cashier token. |
| I-01-4 | `POST /v1/auth/pin-login` `{pin:"9999"}` | 401. |
| I-01-5 | `GET /v1/auth/me` with token | 200, current user; without token → 401. |

## 2. Product sync (QuickBooks → POS)

Precondition: `connectQuickBooks()`; stub returns Inventory + NonInventory + Service items.

| ID | Request | Expected |
| --- | --- | --- |
| I-02-1 | `POST /v1/quickbooks/sync-products` (owner) | 200, `{created,updated,skipped,failed,total}`; Service items in `skipped`. |
| I-02-2 | DB after sync | `Product` rows upserted by `(tenantId,quickbooksItemId)`; fields mapped; `syncStatus=SYNCED`. |
| I-02-3 | Re-run (idempotency) | Second call → `updated` = previous `created`, `created=0`. |
| I-02-4 | `isActive=false` item | Stored `isActive=false`. |
| I-02-5 | Not connected | Disconnect first → 404 "QuickBooks is not connected". |
| I-02-6 | Cashier calls it | 403 (needs `quickbooks:manage`). |
| I-02-7 | `SyncLog` written | One `PRODUCT/INBOUND` log with the counts. |

## 3. Product search

| ID | Request | Expected |
| --- | --- | --- |
| I-03-1 | `GET /v1/products/search?query=cement` | Matches by name (case-insensitive). |
| I-03-2 | `GET /v1/products/search?query=<sku>` | Matches by SKU. |
| I-03-3 | `GET /v1/products/barcode/{barcode}` | Returns the single product; unknown barcode → 404. |
| I-03-4 | `?category=<id>` / `?active=true` | Filters applied. |
| I-03-5 | No token | 401; token without `product:read` → 403. |

## 4. Add to cart → draft

The cart is client-side; the server equivalent is a **draft** sale.

| ID | Request | Expected |
| --- | --- | --- |
| I-04-1 | `POST /v1/sales/draft` with items | 201, DRAFT sale, computed totals, `syncStatus=NOT_SYNCED`, **no** SyncJob. |
| I-04-2 | Draft with unknown product | 400. |
| I-04-3 | Draft references another tenant's product | 400 (tenant-scoped lookup). |

## 5. Quantity change

| ID | Request | Expected |
| --- | --- | --- |
| I-05-1 | Complete with qty within stock | Line total = unitPrice × qty. |
| I-05-2 | Complete with qty > on-hand | 400 "Insufficient stock…". |
| I-05-3 | Fractional qty (e.g. 2.5) | Accepted; line/total correct to 2 dp. |

## 6. Product-wise discount

| ID | Request | Expected |
| --- | --- | --- |
| I-06-1 | Owner completes sale, 10% line discount | 201; item `discountType=PERCENTAGE`, `discountAmount` correct; sale `totalDiscount` reflects it. |
| I-06-2 | Fixed discount | `discountType=FIXED`; amount clamped to line subtotal. |
| I-06-3 | Cashier applies any discount without token | 400 requiring approval (cashier limit 0%). |
| I-06-4 | Discount reason persisted | `discountReason` stored on the SaleItem. |

## 7. Manager approval

| ID | Request | Expected |
| --- | --- | --- |
| I-07-1 | `POST /v1/discounts/approve` `{managerPin:"2222",…, discountValue:10}` | 200 `{approved:true, approvedByUserId, approvalToken}`. |
| I-07-2 | Manager approves 20% | `approved:false` (over manager 15% cap). |
| I-07-3 | Complete cashier sale with a valid `approvalToken` | 201; SaleItem `approvedByUserId` = manager. |
| I-07-4 | Complete with tampered/expired token | 400/401; sale not created. |
| I-07-5 | Wrong manager PIN | 401. |

## 8. Cash payment

| ID | Request | Expected |
| --- | --- | --- |
| I-08-1 | `POST /v1/sales/complete` CASH = total | 201; `paymentStatus=PAID`, `balanceAmount=0`, `quickbooksDocumentType=SALES_RECEIPT`, `syncStatus=PENDING`. |
| I-08-4 | Complete with a past `saleDate` | 201; `completedAt` falls on the picked day; stock still decremented in the same transaction. |
| I-08-5 | Complete with a future `saleDate` | 400; no Sale row and no SyncJob created; stock unchanged. |
| I-08-6 | Sales history is filtered by the invoice date | A backdated sale is returned for its picked day and absent from today's range. |
| I-08-2 | SyncJob enqueued | One `SyncJob` (`SALES_SYNC`,`PENDING`) + `SyncLog` (`SALE/OUTBOUND/PENDING`) in the same tx. |
| I-08-3 | Payment row | `method=CASH`, `syncStatus=NOT_SYNCED`. |

## 9. Card payment

| ID | Request | Expected |
| --- | --- | --- |
| I-09-1 | Complete CARD = total, with `reference` | `PAID` → `SALES_RECEIPT`; reference stored. |
| I-09-2 | Other methods (BANK_TRANSFER/QR_PAYMENT/CHECK) | Accepted; status derived from amount. |

## 10. Partial payment

| ID | Request | Expected |
| --- | --- | --- |
| I-10-1 | Complete with customer, paid < total | 201; `PARTIAL`, `balanceAmount=total−paid`, `quickbooksDocumentType=INVOICE`. |
| I-10-2 | Credit sale paid = 0 | `UNPAID` → `INVOICE`. |
| I-10-3 | INVOICE without customer | 400. |
| I-10-4 | Split payment lines | `paidAmount` = Σ lines; each `Payment` persisted. |

## 10a. Credit management (due dates, settlement, receivables)

Automated end-to-end in `apps/e2e/tests/credit-management.spec.ts`.

| ID | Request | Expected |
| --- | --- | --- |
| I-10a-1 | Complete leaving a balance, no `paymentDueDate` | 400, message names the due date. |
| I-10a-2 | Complete fully paid **with** a `paymentDueDate` | 400. |
| I-10a-3 | Complete on credit with a due date | 201; `GET /sales/{id}` returns it. |
| I-10a-4 | Due date before the invoice date | 400. |
| I-10a-5 | `GET /sales?overdue=true` | Only COMPLETED sales past due and still owing. |
| I-10a-6 | Settle an overdue sale, re-query | The sale drops out of the overdue filter. |
| I-10a-7 | `POST /payments {customerId}` part payment | Account balance drops; NO invoice settled, not even the oldest. |
| I-10a-8 | Pay the rest | Every sale outstanding at that moment gets `creditSettledAt`; `salesSettled` reports the count. |
| I-10a-9 | Payment over the account balance | 400; balance unchanged. |
| I-10a-10 | Payment against a cleared account | 400 "nothing outstanding". |
| I-10a-18 | A sale after settlement | Starts a fresh balance; the covered sales stay settled. |
| I-10a-19 | Settlement and the invoice figures | `paidAmount`/`balanceAmount`/payment rows unchanged — only `creditSettledAt` is written. |
| I-10a-20 | Consumed payments | Retired via `Payment.settledAt`, so they are not subtracted from the next balance. |
| I-10a-11 | Sales list row after a payment | `lastPaymentAt` set; `paymentDueDate` returned. |
| I-10a-12 | Customers list for a credit customer | `outstandingCredit` = owed; `availableCredit` = limit − owed. |
| I-10a-13 | Customer with `creditLimit: null` | `availableCredit` is **null**, not 0. |
| I-10a-14 | Settle, then re-read the customer | Outstanding 0; available back to the full limit. |
| I-10a-15 | `GET /customers?hasOutstandingCredit=true` | Only customers who currently owe. |
| I-10a-16 | `GET /dashboard/stats` before/after a credit sale | `outstandingReceivable` rises by the sale total. |
| I-10a-17 | `GET /dashboard/stats` after settlement | It falls back by the same amount. |

## 11. Receipt print

| ID | Request | Expected |
| --- | --- | --- |
| I-11-1 | `POST /v1/receipts/{saleId}/customer` | 201; `receiptNumber`, `printJob.type=CUSTOMER_RECEIPT` with printable `html`. |
| I-11-2 | Sale with a pickup product | Response also includes `warehousePrintJob` (WAREHOUSE_PICKING). |
| I-11-3 | `POST /v1/receipts/{saleId}/warehouse` with no pickup items | 400. |
| I-11-4 | `GET /v1/print-jobs?saleId=…` | Lists the jobs with html. |
| I-11-5 | `POST /v1/print-jobs/{id}/mark-printed` | 200; `status=PRINTED`, `printedAt` set. |
| I-11-6 | Receipt on a non-completed sale | 400. |

## 12. QuickBooks Sales Receipt sync (fully paid)

Precondition: connected; a fully-paid sale (I-08-1); stub records created docs.

| ID | Request | Expected |
| --- | --- | --- |
| I-12-1 | `POST /v1/quickbooks/sync-sale/{saleId}` | 200 `{status:"SYNCED", quickbooksDocumentType:"SALES_RECEIPT", quickbooksDocumentId}`. |
| I-12-2 | Stub payload | `salesreceipt` body: lines carry `ItemRef.value=quickbooksItemId`; discounted line net `Amount` + discount in `Description`. |
| I-12-3 | DB after | Sale `syncStatus=SYNCED`, `quickbooksDocumentId` set; payments `SYNCED`; `SyncLog SYNCED`. |
| I-12-4 | Idempotent re-sync | Returns "Sale already synced"; **no** second document created. |
| I-12-5 | Sync a non-completed sale | 400. |

## 13. QuickBooks Invoice + Payment sync (credit / partial)

Precondition: connected; a customer with `Customer.quickbooksCustomerId` set (or deliberately unset, to exercise create-on-miss); a partial sale (I-10-1).

| ID | Request | Expected |
| --- | --- | --- |
| I-13-1 | `POST /v1/quickbooks/sync-sale/{saleId}` | 200 `{quickbooksDocumentType:"INVOICE", quickbooksDocumentId, quickbooksPaymentId}`. |
| I-13-2 | Stub payloads | `invoice` with `CustomerRef`; then `payment` `TotalAmt=paidAmount`, `LinkedTxn→invoice`. |
| I-13-3 | DB after | `quickbooksDocumentId` on sale; `quickbooksPaymentId` on the payment; `SyncLog SYNCED`. |
| I-13-4 | Pure credit (paid=0) | Invoice only; no payment id. |

## 14. Failed sync retry

Use the stub's "force N failures" control. Worker disabled → drive the queue via the worker's
`tick()` (exposed for tests) or via the manual endpoints.

| ID | Request | Expected |
| --- | --- | --- |
| I-14-1 | Sync while stub is down / forced 503 | `POST /quickbooks/sync-sale/{id}` → 200 `{status:"FAILED", message}`; sale **kept** COMPLETED, `syncStatus=FAILED`, `syncError` set (never rolled back). |
| I-14-2 | `SyncLog FAILED` written | Log row with the error and incremented attempt. |
| I-14-3 | Worker auto-retry | With forced 2 failures then success: after two `tick()`s the job stays PENDING with backoff, third → `SYNCED` (attempt 3). |
| I-14-4 | Exhaustion | Force ≥ maxAttempts failures → job ends `FAILED` (terminal). |
| I-14-5 | Manual retry (button) `POST /v1/sync/sales/{saleId}/retry` | 202 `{id, syncStatus:"PENDING"}`; job reset (`attempts=0`), sale `syncStatus=PENDING`. |
| I-14-6 | Retry then drain | Next `tick()` (stub healthy) → job `SYNCED`, sale `SYNCED`, document created. |
| I-14-7 | Immediate retry `POST /v1/quickbooks/retry/{syncLogId}` | Re-runs the sale sync synchronously; unknown/ non-SALE log → 404/400. |

## 15. Role access

Run the same protected request as each role; assert allow/deny.

Salesperson is an owner-equivalent role, so its column must match Owner's on every row.

| ID | Endpoint | Owner | Admin | Salesperson | Manager | Cashier | Accountant |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I-15-1 | `POST /sales/complete` (`sale:create`) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ 403 |
| I-15-2 | `POST /discounts/approve` (`sale:create`) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| I-15-3 | `POST /quickbooks/sync-products` (`quickbooks:manage`) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| I-15-4 | `POST /quickbooks/sync-sale/:id` (`quickbooks:manage`) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| I-15-5 | `GET /sync/logs` (`sync:read`) | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| I-15-6 | `POST /sync/sales/:id/retry` (`sync:read`) | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| I-15-7 | `GET /quickbooks/connect` (`@Roles OWNER/ADMIN/SALESPERSON`) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| I-15-8 | No / invalid JWT on any protected route | 401 for all. |
| I-15-9 | Cross-tenant read (token tnt_dev, id from another tenant) | 404 (tenant-scoped), never leaks. |

> Note: the manager discount limit (15%) is enforced by business logic, not the permission guard —
> `discount:approve` grants the *ability* to approve; the value cap is checked in `DiscountsService`.

---

### Exit criteria

- All `I-*` cases green in CI against a fresh migrated+seeded DB.
- No test reaches the real Intuit API (assert requests hit the stub host).
- Teardown drops the test DB / container; no residual rows leak between suites (each suite
  seeds/uses its own tenant data or truncates between runs).
