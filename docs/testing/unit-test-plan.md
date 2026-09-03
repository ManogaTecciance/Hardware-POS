# Unit Test Plan — Hardware POS

Scope: isolated business logic. Dependencies (Prisma, repositories, HTTP/QuickBooks, JWT clock)
are **mocked**. No database, no network. Framework: Jest (`pnpm --filter @hardware-pos/api test`).

Conventions:
- Arrange/act/assert; one behaviour per test.
- Mock repositories with `jest.fn()`; assert both the return value **and** the calls made.
- Money is `Decimal`/number to 2 dp — assert exact values (e.g. `15.30`, not `~15.3`).
- IDs: `U-<area>-<n>`.

Suggested locations: co-locate as `*.spec.ts` next to the unit (e.g.
`apps/api/src/modules/discounts/discounts.service.spec.ts`, `common/money.spec.ts`).

---

## 1. Login & auth

Units: `AuthService`, `JwtStrategy`/token issuance, `roleHasPermission`.

| ID | Case | Expected |
| --- | --- | --- |
| U-01-1 | Email login with correct password | Returns `{ token, user }`; `bcrypt.compare` called; token payload has `sub`, `tenantId`, `role`. |
| U-01-2 | Email login, wrong password | `UnauthorizedException`; no token issued. |
| U-01-3 | Email login, unknown email | `UnauthorizedException` (same message as wrong password — no user enumeration). |
| U-01-4 | PIN login, correct PIN for tenant | Returns token for the matched user; `bcrypt.compare(pin, pinHash)` used. |
| U-01-5 | PIN login, wrong PIN | `UnauthorizedException`. |
| U-01-6 | PIN login, non-numeric PIN | Rejected by DTO `@Matches(/^\d+$/)` (validation). |
| U-01-7 | Inactive user | Login rejected. |
| U-01-8 | Token expiry honoured | Token signed with `JWT_EXPIRES_IN`; expired token fails verification. |

## 2. Product sync mapping

Unit: `QuickBooksSyncService` field mapping + `IMPORTABLE_TYPES` filter (repository/HTTP mocked).

| ID | Case | Expected |
| --- | --- | --- |
| U-02-1 | Map an `Inventory` item | `name/sku/description/unitPrice/quantityOnHand/type/isActive` mapped; `syncStatus=SYNCED`, `lastSyncedAt` set. |
| U-02-2 | Map a `NonInventory` item | Imported (no `QtyOnHand` → `quantityOnHand=0`). |
| U-02-3 | `Service` / other type | Skipped (counts to `skipped`, not upserted). |
| U-02-4 | Missing optional fields (`Sku`, `Description`, `UnitPrice`) | Defaults: `sku=null`, `description=null`, `unitPrice=0`. |
| U-02-5 | `Active=false` | Persisted as `isActive=false`. |
| U-02-6 | Existing vs new item | Existence check drives `created` vs `updated` counts. |
| U-02-7 | One item throws mid-loop | `failed++`; loop continues; other items still processed. |
| U-02-8 | Summary + log | Returns `{created,updated,skipped,failed,total}`; a `SyncLog` (`PRODUCT/INBOUND`) is written (`FAILED` if any failed else `SYNCED`). |

## 3. Product search

Unit: `ProductsService.search` query building (repository mocked).

| ID | Case | Expected |
| --- | --- | --- |
| U-03-1 | Search by name (partial, case-insensitive) | `contains`, `mode:'insensitive'` filter built. |
| U-03-2 | Search by SKU | SKU filter applied. |
| U-03-3 | Search by barcode | Barcode filter applied. |
| U-03-4 | Filter by category | Category id constrains results. |
| U-03-5 | `active` filter | Only `isActive=true` when requested. |
| U-03-6 | Empty query | Returns paginated set (no crash); tenant scoping always present. |

## 4. Add to cart (frontend)

Unit: POS cart reducer/store (`apps/web`, Vitest/Jest + Testing Library).

| ID | Case | Expected |
| --- | --- | --- |
| U-04-1 | Add a product | Line added qty 1; line total = unit price. |
| U-04-2 | Add same product again | Quantity merges to 2 (no duplicate line). |
| U-04-3 | Cart totals | Subtotal/discount/tax/total recomputed on each change. |
| U-04-4 | Remove line | Line removed; totals updated; empty cart disables checkout. |
| U-04-7 | Dashboard day windows | The default range, the shift window and the per-day series slots are cut on the shop's midnights, not the server's; a sale in the small hours lands in the right shop day. Covered by `apps/api/src/modules/dashboard/dashboard.service.spec.ts`. |
| U-04-6 | Timezone maths | `zonedTimeToUtc` / `dayInTimeZone` round-trip a calendar day in a named zone and use the offset in force on that day across a DST boundary; `safeTimeZone` degrades an unknown zone to the default. Covered by `apps/web/src/lib/timezone.test.ts`. |
| U-04-5 | Invoice-date helpers | `todayIso` reports the LOCAL day (zero-padded), not the UTC one; `isValidYmd` rejects the partial/6-digit-year values a date input emits mid-typing. Covered by `apps/web/src/lib/dates.test.ts`. |

## 5. Quantity change

Unit: cart quantity logic + line recompute.

| ID | Case | Expected |
| --- | --- | --- |
| U-05-1 | Increment / decrement | Line total = unitPrice × qty; discount re-applied. |
| U-05-2 | Quantity to 0 | Line removed (or blocked, per design). |
| U-05-3 | Quantity > on-hand | Flagged; server rejects at complete (see U-06/integration). |
| U-05-4 | Fractional quantity | Supported to 3 dp (`Decimal(12,3)`), line total to 2 dp. |

## 6. Product-wise discount

Units: `computeDiscount`, `SalesService.computeCart`, `round2`/`sum2`.

| ID | Case | Expected |
| --- | --- | --- |
| U-06-1 | Percentage discount | `discountAmount = round2(lineSubtotal × value/100)`; `lineTotal = lineSubtotal − discountAmount`. |
| U-06-2 | Fixed discount | `discountAmount = min(lineSubtotal, value)`. |
| U-06-3 | Discount clamp | Percentage/fixed never exceed `lineSubtotal` (no negative line total). |
| U-06-4 | No discount | `discountAmount=0`; `lineTotal=lineSubtotal`. |
| U-06-5 | Totals aggregation | `subtotal=Σ lineSubtotal`, `totalDiscount=Σ discountAmount`, `total=round2(taxable+tax)`. |
| U-06-6 | Price-change guard | Client `unitPrice` ≠ cached price → `BadRequestException`. |
| U-06-7 | Stock guard | qty > `quantityOnHand` → `BadRequestException`. |
| U-06-8 | Rounding | `round2`/`sum2` avoid float drift (e.g. 3 × 0.1 = 0.30). |

## 7. Manager approval

Units: `DiscountsService.approve`, `resolveApproval`, approval-token sign/verify.

| ID | Case | Expected |
| --- | --- | --- |
| U-07-1 | Cashier 0% limit exceeded | Over-limit line without token → error requiring approval. |
| U-07-2 | Manager approves ≤15% | `approve` returns `{approved:true, approvedByUserId, approvalToken}` (signed JWT). |
| U-07-3 | Manager approves >15% | `approved:false` — over the manager's own cap. |
| U-07-4 | Owner/Admin/Salesperson | Unlimited; no approval token needed. |
| U-07-5 | Valid token covers the line | `resolveApproval` accepts a token matching product/type/value; sets `approvedByUserId`. |
| U-07-6 | Tampered / expired / mismatched token | Rejected; line not approved. |
| U-07-7 | Wrong manager PIN | `approve` fails auth; no token. |

## 8. Cash payment

Unit: payment-status derivation in `SalesService.complete`.

| ID | Case | Expected |
| --- | --- | --- |
| U-08-1 | Cash = total | `paymentStatus=PAID`, `balanceAmount=0`, `quickbooksDocumentType=SALES_RECEIPT`. |
| U-08-2 | Cash > total (overpay) | `PAID`; `balanceAmount=0` (clamped `max(0, total−paid)`). |
| U-08-3 | Method persisted | Payment row `method=CASH`, `syncStatus=NOT_SYNCED`. |
| U-08-5 | Invoice date is judged in the shop zone | `resolveSaleDate` accepts a day that is already today in the shop's zone while still yesterday in UTC, and rejects one that is tomorrow there. |
| U-08-4 | Invoice date resolution | `resolveSaleDate` keeps the picked calendar day in LOCAL time (never UTC-midnight), carries the current time of day, accepts today, and rejects tomorrow, an impossible day (2026-02-30) and an absurd year. Covered by `apps/api/src/modules/sales/sale-date.spec.ts`. |

## 9. Card payment

| ID | Case | Expected |
| --- | --- | --- |
| U-09-1 | Card = total | `PAID` → `SALES_RECEIPT`. |
| U-09-2 | Reference captured | `reference` stored on the payment. |
| U-09-3 | Enum coverage | `CARD`/`BANK_TRANSFER`/`QR_PAYMENT`/`CHECK`/`STORE_CREDIT`/`OTHER` all accepted by DTO. |

## 10. Partial payment

| ID | Case | Expected |
| --- | --- | --- |
| U-10-1 | 0 < paid < total | `paymentStatus=PARTIAL`; `balanceAmount=total−paid`; `quickbooksDocumentType=INVOICE`. |
| U-10-2 | paid = 0 (pure credit) | `UNPAID` → `INVOICE`. |
| U-10-3 | Invoice needs customer | INVOICE without `customerId` → `BadRequestException`. |
| U-10-4 | Split payments | Multiple payment lines sum correctly to `paidAmount`. |

## 11. Receipt generation

Units: receipt HTML builder + warehouse-pickup detection.

| ID | Case | Expected |
| --- | --- | --- |
| U-11-1 | Customer receipt HTML | Contains sale number, lines, discounts, totals, paid/balance. |
| U-11-2 | Warehouse copy trigger | Only when some line's product `requiresWarehousePickup=true`. |
| U-11-3 | Warehouse copy contents | Lists only pickup items (qty/sku), excludes non-pickup lines. |
| U-11-4 | No pickup items | Warehouse endpoint/logic yields none (or 400 on explicit request). |
| U-11-5 | Receipt number | Unique per sale; `printCount` starts at 0. |

## 12. QuickBooks Sales Receipt document build

Unit: `QuickBooksSalesSyncService.buildLines` / `buildDocumentBody` for a fully-paid sale (HTTP mocked).

| ID | Case | Expected |
| --- | --- | --- |
| U-12-1 | Routing | `SALES_RECEIPT` type builds a `salesreceipt` body. |
| U-12-2 | Line with item ref | `ItemRef.value = quickbooksItemId` when the product has one. |
| U-12-3 | Line without item ref | `ItemRef` omitted when product not synced (TODO documented). |
| U-12-4 | No-discount line | `Amount=lineSubtotal`, `UnitPrice` included. |
| U-12-5 | Discounted line | `Amount=lineTotal` (net), `UnitPrice` omitted, discount noted in `Description`. |
| U-12-6 | Tax | `TxnTaxDetail.TotalTax` only when `taxAmount>0`. |
| U-12-7 | Invoice date | `TxnDate` = the sale's `completedAt` as a bare local `YYYY-MM-DD`; a late-evening sale does not roll to the next day. Covered by `apps/api/src/modules/quickbooks/quickbooks-sales-sync.service.spec.ts`. |

## 13. QuickBooks Invoice + Payment document build

| ID | Case | Expected |
| --- | --- | --- |
| U-13-1 | Routing | Credit/partial builds an `invoice` body. |
| U-13-2 | CustomerRef from the customer record | Resolved from `Customer.quickbooksCustomerId` (mirroring `Product.quickbooksItemId`); `QuickBooksMapping` is never consulted. A customer with no link is created in QuickBooks first, or an existing one of the same name adopted. Covered by `apps/api/src/modules/quickbooks/quickbooks-customers.service.spec.ts`. |
| U-13-3 | Payment created when paid>0 | A `payment` body with `TotalAmt=paidAmount`, `LinkedTxn → invoice`. |
| U-13-4 | Pure credit (paid=0) | Invoice only, no payment. |
| U-13-5 | Invoice with no resolvable customer | Fails with a clear POS-worded message before calling QuickBooks, rather than surfacing QBO's raw `CustomerRef is required` (6560). |
| U-13-6 | Payment date | The linked Payment carries the same `TxnDate` as its invoice, so it is never dated ahead of the sale it settles. |

## 14. Sync queue & retry logic

Units: `SyncQueueService` (`claimDueJobs`, `markFailed`, `requeueSale`, `nextAttempt`), `SyncWorkerService.process` (queue + handlers mocked).

| ID | Case | Expected |
| --- | --- | --- |
| U-14-1 | Enqueue on completion | `enqueueSaleSync` creates `SyncJob` (`SALES_SYNC`, `PENDING`) + `SyncLog` in the passed tx. |
| U-14-2 | Claim guard | Only `PENDING`, `scheduledAt<=now`, `attempts<maxAttempts` claimed; claim flips to `SYNCING`, `attempts++`. |
| U-14-3 | Concurrent claim | Conditional update: a second claim of the same job returns count 0 (not double-processed). |
| U-14-4 | Fail with attempts left | `markFailed` → back to `PENDING`, `scheduledAt=now+backoff×attempts`, `lastError` stored. |
| U-14-5 | Fail exhausted | attempts = maxAttempts → status `FAILED` (terminal). |
| U-14-6 | Requeue (manual retry) | `requeueSale` → job `PENDING`, `attempts=0`, `scheduledAt=now`; sale `syncStatus=PENDING`. |
| U-14-7 | Worker dispatch | `process` routes by `type` to the handler; unknown type → `markFailed('No handler…')`. |
| U-14-8 | Handler success/failure | success → `markSucceeded`; `{success:false}` or throw → `markFailed`. |
| U-14-9 | Stale reclaim | `reclaimStaleJobs` returns `SYNCING` older than `staleMs` to `PENDING`. |

## 15. Role access (authorization)

Units: `PermissionsGuard`, `RolesGuard`, `roleHasPermission`, `ROLE_PERMISSIONS`.

| ID | Case | Expected |
| --- | --- | --- |
| U-15-1 | Permission map correctness | Cashier lacks `discount:approve` & `quickbooks:manage`; Manager has `discount:approve`; Accountant has `sync:read`,`quickbooks:read` but not `sale:create`. |
| U-15-2 | `@RequirePermissions` allow | User whose role includes the permission → guard returns true. |
| U-15-3 | `@RequirePermissions` deny | Missing permission → `ForbiddenException`. |
| U-15-4 | `@Roles` allow/deny | `quickbooks:connect` restricted to OWNER/ADMIN/SALESPERSON. |
| U-15-5 | `@Public` bypass | Public routes skip auth. |
| U-15-6 | Missing/invalid JWT | `JwtAuthGuard` → `UnauthorizedException`. |
| U-15-7 | Tenant scoping | `@TenantId` from JWT (falls back to `x-tenant-id`); cross-tenant id is never trusted from the body. |
| U-15-8 | Salesperson ↔ Owner parity | `ROLE_PERMISSIONS.SALESPERSON` equals `ROLE_PERMISSIONS.OWNER`; same unlimited discount limit; `isAdminLevelRole` true. Covered by `apps/api/src/modules/auth/permissions.spec.ts`. |

---

### Coverage targets

- `common/` helpers (money, pagination) and `discounts`, `sales` compute, `quickbooks` build,
  and `sync/queue` logic: **≥ 90%** lines.
- Guards and mappers: every branch has a case.
- Run `pnpm --filter @hardware-pos/api test:cov` and attach the summary to the release ticket.
