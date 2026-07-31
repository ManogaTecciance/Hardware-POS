# AxloPOS — System Test Cases

Master test-case inventory for the Hardware POS system (web + API). Each case
has a stable ID for traceability into automated Playwright specs.

- **Type**: `P` = positive (happy path), `N` = negative (error/guard path)
- **Status**: `Not Run` → `Pass` / `Fail` / `Blocked` / `Automated` (update as
  cases are executed manually or scripted)
- Unless stated otherwise, cases assume the seeded demo tenant and the roles:
  Owner (email login), Manager, Cashier, Accountant.

Modules: [AUTH](#auth--sessions) · [PERM](#perm--roles--permissions) ·
[DASH](#dash--dashboards) · [PROD](#prod--products--categories) ·
[PIMP](#pimp--product-bulk-import) · [POS](#pos--point-of-sale) ·
[PAY](#pay--payments--credit) · [SALE](#sale--sales-history) ·
[RET](#ret--returns--refunds) · [QUO](#quo--quotations) ·
[CUST](#cust--customers) · [CIMP](#cimp--customer-bulk-import) ·
[SUP](#sup--suppliers-vendors) · [SIMP](#simp--vendor-bulk-import) ·
[QB](#qb--quickbooks-integration) · [SET](#set--settings) ·
[DOC](#doc--documents--printing) · [ADM](#adm--administration--multi-tenancy) ·
[UI](#ui--theme-layout--responsiveness) · [SEC](#sec--security)

---

## AUTH — Sessions

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| AUTH-001 | Owner logs in with valid email + password | Enter owner email + password, Sign in | Redirected to dashboard; session persisted; admin dashboard shown | P | Not Run |
| AUTH-002 | Cashier logs in with valid email + password | Enter cashier credentials, Sign in | Cashier dashboard (shift view) shown | P | Not Run |
| AUTH-003 | Login with wrong password | Valid email, wrong password | "Invalid email or password"; stays on login | N | Not Run |
| AUTH-004 | Login with unknown email | Nonexistent email | Same generic error (no user enumeration) | N | Not Run |
| AUTH-005 | Login with empty fields | Submit with blank email/password | Client validation blocks; no API call | N | Not Run |
| AUTH-006 | Inactive user cannot log in | Deactivate a user, attempt login | "Invalid email or password" | N | Not Run |
| AUTH-007 | Cashier PIN login (demo tenant) | Enter valid cashier PIN in PIN box | Logged in as cashier | P | Not Run |
| AUTH-008 | PIN login with wrong PIN | Enter unused PIN | Error shown; not logged in | N | Not Run |
| AUTH-009 | PIN login is demo-tenant scoped | Use a non-demo tenant user's PIN in login PIN box | Rejected (PIN box resolves against demo tenant only) | N | Not Run |
| AUTH-010 | Session survives reload | Log in, hard-reload the browser | Still authenticated; same route restored | P | Not Run |
| AUTH-011 | Logout clears session | Account menu → Log out | Redirected to /login; back-button does not restore an authenticated page | P | Not Run |
| AUTH-012 | Expired access token silently refreshes | Wait past access-token TTL (or force 401), perform an action | Token refresh rotates; request succeeds without logout | P | Not Run |
| AUTH-013 | Revoked refresh token forces re-login | Revoke refresh token server-side, trigger refresh | User dropped to /login without 401 loops | N | Not Run |
| AUTH-014 | Unauthenticated deep link redirects | Open /products while logged out | Redirected to /login | N | Not Run |
| AUTH-015 | Corrupt localStorage session handled | Write malformed JSON to session key, load app | App drops to /login without crashing | N | Not Run |

## PERM — Roles & Permissions

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| PERM-001 | Owner sees all nav entries | Log in as owner | Dashboard, POS, Sales, Quotations, Returns, Products, Suppliers, Customers, QuickBooks, Settings visible | P | Not Run |
| PERM-002 | Cashier nav is restricted | Log in as cashier | No Suppliers, Settings, or QuickBooks management entries | P | Not Run |
| PERM-003 | Cashier blocked from suppliers page | Cashier opens /suppliers directly | "No access" empty state; no data fetched | N | Not Run |
| PERM-004 | Cashier cannot manage products via API | POST /v1/products with cashier token | 403 Forbidden | N | Not Run |
| PERM-005 | Accountant is read-only on suppliers | Accountant opens a supplier profile | No Edit/Delete buttons; mapping actions visible (QB map permission) | P | Not Run |
| PERM-006 | Manager cannot permanently delete a supplier | Manager opens supplier profile | Delete button absent; DELETE /suppliers/:id returns 403 | N | Not Run |
| PERM-007 | Cashier cannot see gross profit card | Cashier dashboard | No Gross Profit KPI (REPORT_READ gated) | P | Not Run |
| PERM-008 | API rejects missing permissions consistently | Call representative manage endpoints per role matrix | 403 for each disallowed role | N | Not Run |
| PERM-009 | User management requires USER_MANAGE | Cashier calls GET /v1/users | 403 | N | Not Run |

## DASH — Dashboards

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| DASH-001 | Admin KPI band shows 5 cards | Owner opens dashboard | Net Sales, Gross Profit, Transactions, Total Inventory Value, Open Quotations | P | Not Run |
| DASH-002 | KPI cards on one row at laptop width | 1280×800 viewport, sidebar expanded | All 5 cards share one row | P | Not Run |
| DASH-003 | KPI row unaffected by sidebar collapse | Collapse sidebar at 1280×800 | Still one row | P | Not Run |
| DASH-004 | Millions render compactly | Inventory value ≥ Rs. 1,000,000 | Shown as `Rs. X.XXXXmil` (≤4 decimals, zeros trimmed) | P | Not Run |
| DASH-005 | Sub-million values keep full format | Card value 999,999.99 | `Rs. 999,999.99` (no "mil") | P | Not Run |
| DASH-006 | Inventory value equals cost × on-hand | Compare card to SQL Σ(qty×cost) over active Inventory items | Values match; null cost counts as zero | P | Not Run |
| DASH-007 | Inventory card deep-links to products | Click Total Inventory Value | Navigates to /products | P | Not Run |
| DASH-008 | Out-of-stock alert count matches list | Compare alert count vs /products?stockStatus=OUT total | Counts equal | P | Not Run |
| DASH-009 | Alert deep-link applies filter | Click out-of-stock alert | Products page opens pre-filtered to OUT | P | Not Run |
| DASH-010 | Low-stock alert requires reorder point | Product below default-less threshold, no reorderLevel | Not counted as low stock anywhere (dashboard + POS) | N | Not Run |
| DASH-011 | Low-stock consistency dashboard vs POS | Product with reorderLevel ≥ on-hand | Flagged low in both dashboard alert and POS badge | P | Not Run |
| DASH-012 | Cashier KPI band shows shift stats | Cashier opens dashboard | Shift Sales, Transactions, Average Bill, Expected Cash | P | Not Run |
| DASH-013 | Sales chart range switcher | Toggle Today/7D/30D/3M/6M/1Y | Series refetches; axis rescales; no errors | P | Not Run |
| DASH-014 | Dashboard degrades when API down | Stop API, load dashboard | Error state with Retry; no crash; Retry recovers after API returns | N | Not Run |
| DASH-015 | Branch/register chips absent | Inspect header + dashboard hero | No "Main Branch"/"Register 1" labels (kept only in account dropdown) | P | Not Run |
| DASH-016 | Empty tenant dashboard renders zeros | Fresh tenant owner logs in | All KPIs zero/empty states; no NaN or errors | P | Not Run |
| DASH-017 | Payment methods card matches sales | Complete sales via two methods, view card | Split/amounts per method match the recorded payments | P | Not Run |
| DASH-018 | Top categories/products ranked correctly | Known sales mix in window | Ranked by amount; units and sale counts correct | P | Not Run |
| DASH-019 | "Today" boundary respected | Sale completed yesterday (server-local midnight) | Excluded from today's Net Sales / Transactions | P | Not Run |
| DASH-020 | Cashier register health card | Cashier dashboard | QuickBooks health + expected cash consistent with shift summary | P | Not Run |

## PROD — Products & Categories

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| PROD-001 | Create Inventory product with all QB fields | Fill name, SKU, category, prices, qty, reorder point | Created; appears in list and POS catalog | P | Not Run |
| PROD-002 | Create Service product | Type = Service, no stock fields | Created; POS treats it as non-stock (no cap, no badges) | P | Not Run |
| PROD-003 | Create Non-Inventory product | Type = Non-Inventory | Created; not stock-tracked | P | Not Run |
| PROD-004 | Name is required | Submit without name | Validation error; no create | N | Not Run |
| PROD-005 | Negative price rejected | unitPrice −5 | 400 / client validation | N | Not Run |
| PROD-006 | Edit product updates POS catalog | Change price, reload POS | New price used in cart | P | Not Run |
| PROD-007 | Deactivate product hides from POS | Set inactive | Absent from POS; still in products list under Inactive filter | P | Not Run |
| PROD-008 | New product visible beyond 200-item page cap | Tenant with >200 products; create "ZZZ" product | Appears in POS search (client pages through all) | P | Not Run |
| PROD-009 | Category `Parent:Sub` created on the fly | Assign a new path during create/import | Category + subcategory created once, reused thereafter | P | Not Run |
| PROD-010 | Category reorder persists | Drag/reorder categories, reload | Order kept in management list and POS chips | P | Not Run |
| PROD-011 | Deactivate category | Deactivate a category with products | Hidden from POS chips; products remain accessible via search | P | Not Run |
| PROD-012 | Subcategory move between categories | Move sub to another category | Tree updates; product assignments intact | P | Not Run |
| PROD-013 | Product list filters combine | Stock=LOW + sync=SYNCED + search term | Result satisfies all predicates | P | Not Run |
| PROD-014 | stockStatus=OUT filter exact | Apply OUT filter | Only Inventory items with qty ≤ 0 | P | Not Run |
| PROD-015 | Export respects active filters | Filter list, export | File contains only filtered rows | P | Not Run |
| PROD-016 | Upload product image | Attach JPG/PNG on product | Stored via storage provider as WebP; renders in list/POS via presigned redirect | P | Not Run |
| PROD-017 | Replace and delete image | Upload new image; then delete | Old object replaced; delete clears imageUrl and POS falls back to placeholder | P | Not Run |
| PROD-018 | Oversized/invalid image rejected | Upload 20MB file / a .txt renamed .png | 4xx with clear message; product unchanged | N | Not Run |
| PROD-019 | Image never sent to QuickBooks | Sync product with image | QBO Item payload contains no image data | P | Not Run |
| PROD-020 | Duplicate SKU within tenant rejected | Create product with existing SKU | Conflict error surfaced | N | Not Run |
| PROD-021 | Pagination boundaries | Navigate to last page; request page beyond last via API | UI clamps; API returns empty items, correct total | N | Not Run |
| PROD-022 | Search by SKU and partial name | Search exact SKU, then substring | Matching rows only, case-insensitive | P | Not Run |
| PROD-023 | Hard delete product without history | Delete a never-sold product | Removed from list and POS | P | Not Run |
| PROD-024 | Delete product with sales history handled | Attempt delete of a sold product | Blocked or soft-handled; old sale detail still renders its line | N | Not Run |
| PROD-025 | Negative reorder point rejected | reorderLevel −1 | Validation error | N | Not Run |
| PROD-026 | QB account names shown read-only | Product pulled from QBO with income/expense/asset accounts | Account names displayed, not editable locally | P | Not Run |
| PROD-027 | Subcategory library is browser-local (known mock) | Assign shared subcategory, open app in second browser | Assignment absent there — frontend-only adapter until backend lands | N | Not Run |

## PIMP — Product Bulk Import

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| PIMP-001 | Download product template | Import dialog → Template | .xlsx with QB Products & Services headers + sample rows | P | Not Run |
| PIMP-002 | Preview valid sheet | Upload filled template | Review table lists all rows; create/update badges correct | P | Not Run |
| PIMP-003 | Existing SKU matched as update | Sheet row with known SKU | Row badged Update; commit updates not duplicates | P | Not Run |
| PIMP-004 | Name-only match when SKU blank | Row without SKU but existing name | Matched as update by name (case-insensitive) | P | Not Run |
| PIMP-005 | Invalid number flagged per-row | "abc" in Sales price | Row shows error, excluded from commit; others unaffected | N | Not Run |
| PIMP-006 | Invalid date flagged | Bad "Quantity as of date" | Row error; excluded | N | Not Run |
| PIMP-007 | Duplicate SKU inside sheet flagged | Two rows share a SKU | Second row errored with row reference | N | Not Run |
| PIMP-008 | Image attach per row in review | Add photo to a row, commit | Product created and image uploaded to that product | P | Not Run |
| PIMP-009 | Commit summary accurate | Commit mixed create/update sheet | created/updated/failed counts match rows | P | Not Run |
| PIMP-010 | Empty/wrong-header sheet rejected | Upload sheet without the name column | 400 "Header row not found…" in dialog | N | Not Run |
| PIMP-011 | Non-spreadsheet file rejected | Upload a .pdf | Friendly parse error | N | Not Run |
| PIMP-012 | >10MB upload rejected | Upload oversized file | 413/400 "File is too large" | N | Not Run |
| PIMP-013 | Cancel mid-review creates nothing | Preview then close dialog | No products created | P | Not Run |

## POS — Point of Sale

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| POS-001 | Add product to cart | Click product card Add | Line appears with qty 1 and unit price | P | Not Run |
| POS-002 | Same product increments | Add same product twice | Single line, qty 2 | P | Not Run |
| POS-003 | Quantity + / − buttons | Use steppers | Qty changes; totals recompute | P | Not Run |
| POS-004 | Typed quantity commits on blur/Enter | Type 12 in qty box | Qty = 12; "03" normalizes to 3 | P | Not Run |
| POS-005 | Typed quantity clamps to stock | Inventory item stock 5, type 99 | Qty capped at 5 | N | Not Run |
| POS-006 | + disabled at stock cap | Reach on-hand qty | + disabled with "No more stock available" tooltip | P | Not Run |
| POS-007 | Empty/garbage qty reverts | Clear box and blur | Reverts to previous qty (removal only via trash) | N | Not Run |
| POS-008 | Service item has no cap | Add Service item, type 500 | Accepted (not stock-tracked) | P | Not Run |
| POS-009 | Out-of-stock product not addable | Product qty 0 | Card shows Out-of-stock badge; Add disabled | N | Not Run |
| POS-010 | Low-stock badge only with reorder point | qty ≤ reorderLevel set | Badge shown; absent when reorderLevel null | P | Not Run |
| POS-011 | Category / subcategory chips filter | Select category then sub | Grid filters to selection; counts consistent | P | Not Run |
| POS-012 | Search products in POS | Type SKU/partial name | Grid filters live | P | Not Run |
| POS-013 | Remove line via trash | Delete a cart line | Line removed; totals update; order discount cleared when cart empties | P | Not Run |
| POS-014 | Cart persists to payment and back | Fill cart → Payment → back | Cart, customer, notes, discounts intact (sessionStorage) | P | Not Run |
| POS-015 | Cart cleared after completed sale | Complete a sale | Return to POS with empty cart | P | Not Run |
| POS-016 | Line note saved | Add note to a line, complete sale | Note visible on sale detail | P | Not Run |
| POS-017 | Line discount within cashier limit | Small % discount as cashier | Applied without approval | P | Not Run |
| POS-018 | Over-limit discount asks for manager PIN | Cashier applies large % | Approval dialog appears; blocked until approved | P | Not Run |
| POS-019 | Manager PIN approves over-limit discount | Enter manager PIN in dialog | Discount applied; approver recorded on sale line | P | Not Run |
| POS-020 | Owner PIN accepted at manager prompt | Enter owner PIN instead | Approved (permission-based, not role-name based) | P | Not Run |
| POS-021 | Cashier's own PIN cannot approve | Enter cashier PIN | "Not allowed to approve discounts" | N | Not Run |
| POS-022 | Wrong PIN rejected | Enter unused PIN | 401 Invalid manager PIN; dialog stays | N | Not Run |
| POS-023 | Approval token is discount-specific | Approve 25% on product A, attempt to reuse for product B / different % | Completion rejects; fresh approval required | N | Not Run |
| POS-024 | Approval token expires | Wait past TTL (15m) then complete | Approval required again | N | Not Run |
| POS-025 | Order-level discount over limit | Cart-wide discount over cashier limit | Same approval flow via order dialog | P | Not Run |
| POS-026 | Fixed discount larger than line rejected | Fixed discount > line subtotal | Clamped/rejected; total never negative | N | Not Run |
| POS-027 | Quick-add customer from POS | Add name+phone(+street) in dialog | Customer created, selected in cart, appears in Customers | P | Not Run |
| POS-028 | Catalog refresh updates cart snapshot | Change price in another tab, reload POS | Cart line reflects fresh price/stock | P | Not Run |
| POS-029 | POS with API down | Stop API, open POS | Error banner + Retry; no fake catalog | N | Not Run |
| POS-030 | POS page never scrolls document | Long catalog | Only internal regions scroll (viewport-locked shell) | P | Not Run |
| POS-031 | Hold sale as draft | Create draft via POST /sales/draft with cart lines | Draft persisted; stock NOT decremented | P | Not Run |
| POS-032 | Complete a held draft | Complete the draft later | Stock decremented exactly once; sale gets final S-number | P | Not Run |
| POS-033 | Draft re-validates stock at completion | Stock sells out after drafting; complete draft | 400 insufficient stock; nothing partial | N | Not Run |

## PAY — Payments & Credit

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| PAY-001 | Cash payment with change | Tender > total | Change computed; sale COMPLETED/PAID | P | Not Run |
| PAY-002 | Card payment exact | Card for full amount | Sale PAID; payment method recorded | P | Not Run |
| PAY-003 | Split payment | Cash + card summing to total | Both payments stored; PAID | P | Not Run |
| PAY-004 | Split under-payment blocked | Payments sum < total without credit customer | Cannot complete as PAID; treated partial/blocked per rules | N | Not Run |
| PAY-005 | Partial payment for credit customer | creditAllowed customer, pay half | Sale COMPLETED/PARTIAL with balance | P | Not Run |
| PAY-006 | Credit sale (pay later) | creditAllowed customer, zero tender | COMPLETED/UNPAID with full balance | P | Not Run |
| PAY-007 | Credit blocked for non-credit customer | Balance>0 with creditAllowed=false | 400 "not approved for credit…" | N | Not Run |
| PAY-008 | Credit blocked without customer | Balance>0, no customer selected | Rejected (credit needs a saved customer) | N | Not Run |
| PAY-009 | Credit limit enforced | Outstanding + new balance > creditLimit | 400 with limit / outstanding / remaining figures | N | Not Run |
| PAY-010 | Credit exactly at limit allowed | New balance = remaining limit | Sale completes | P | Not Run |
| PAY-011 | Null credit limit = unlimited | creditAllowed, creditLimit null, huge balance | Sale completes | P | Not Run |
| PAY-012 | Outstanding aggregates prior credit sales | Two UNPAID sales then a third exceeding limit | Third rejected; message reflects summed outstanding | N | Not Run |
| PAY-013 | Stock decremented once on completion | Complete sale qty 2 | quantityOnHand −2 exactly | P | Not Run |
| PAY-014 | Oversell blocked at completion (race) | Two carts each taking remaining stock, complete both | One succeeds, other 400 Insufficient stock; no negative stock | N | Not Run |
| PAY-015 | Sale numbers gapless and unique under concurrency | Complete 6 sales in parallel | Distinct sequential S-xxxxxx; deleted sales never reuse numbers | P | Not Run |
| PAY-016 | Zero-total sale disallowed | Empty cart complete attempt | Blocked client- and server-side | N | Not Run |
| PAY-017 | Bank transfer / QR / cheque with reference | Pay via each method with a reference string | Method + reference stored and visible on sale detail | P | Not Run |
| PAY-018 | Cash tender below total blocked (non-credit) | Walk-in, tender < total | Cannot complete the sale | N | Not Run |
| PAY-019 | Settle credit sale with POST /payments | Record payment {saleId, method, amount} against UNPAID sale | Balance reduces; PARTIAL→PAID when it reaches zero | P | Not Run |
| PAY-020 | Settlement frees credit headroom | Settle a sale, then retry a previously over-limit credit sale | Now allowed — outstanding recomputed from balances | P | Not Run |
| PAY-021 | Overpayment on settlement rejected | Payment amount > remaining balance | 400 | N | Not Run |
| PAY-022 | Payment against a PAID sale rejected | POST /payments on a settled sale | 400 | N | Not Run |

## SALE — Sales History

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| SALE-001 | Sales list shows completed sales | Complete a sale, open /sales | Newest sale on top with totals + payment status | P | Not Run |
| SALE-002 | Filter by date range | Set from/to around a known sale | Only matching sales | P | Not Run |
| SALE-003 | Invalid date input handled | Type absurd year (e.g. 202020) | Client blocks (min/max); API returns 400 not 500 | N | Not Run |
| SALE-004 | Open-ended presets | "Last 7 days" etc. | Correct window applied | P | Not Run |
| SALE-005 | Filter by payment status | UNPAID filter | Only credit/partial sales | P | Not Run |
| SALE-006 | Sale detail complete | Open a sale | Items, discounts+approver, payments, balance, sync status | P | Not Run |
| SALE-007 | Retry sync action | On FAILED sale, Retry | Re-queued; status transitions PENDING→SYNCED | P | Not Run |
| SALE-008 | Nonexistent sale id | /sales/unknown-id | 404 page/state, no crash | N | Not Run |
| SALE-009 | Cashier sees only permitted actions | Cashier opens sale detail | No admin-only actions (e.g. retry-sync if QB-gated) | P | Not Run |
| SALE-010 | Sales report endpoint | GET /sales/report for a date range | Aggregates match the underlying sales; filters respected | P | Not Run |
| SALE-011 | Manual per-sale sync | POST /sales/:id/sync on a NOT_SYNCED sale | Queued and pushed like the automatic path | P | Not Run |

## RET — Returns & Refunds

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| RET-001 | Start return from eligible sale | New return → pick recent sale | Returnable items listed with remaining quantities | P | Not Run |
| RET-002 | Return window enforced | Sale older than configured days | Marked ineligible with reason | N | Not Run |
| RET-003 | Cannot return more than purchased | Qty > sold−already returned | Blocked per line | N | Not Run |
| RET-004 | Full return completes | Return all items, cash refund | Return COMPLETED; sale marked FULLY_RETURNED | P | Not Run |
| RET-005 | Partial return arithmetic | Return 1 of 3 | Refund = line share incl. discounts/tax; sale PARTIALLY_RETURNED | P | Not Run |
| RET-006 | Second return of same line capped | Return remaining then attempt more | Second attempt blocked | N | Not Run |
| RET-007 | Restock disposition returns stock eagerly | Condition GOOD → RETURN_TO_STOCK | `quantityOnHand` increases the instant the return completes (in the return transaction), symmetric with a sale's decrement and independent of the async QuickBooks push | P | Not Run |
| RET-008 | Damaged disposition does not restock | DAMAGED_STOCK / non-resellable condition | On-hand unchanged; damaged stock never re-enters available inventory | P | Not Run |
| RET-009 | Store credit requires saved customer | Walk-in sale → store-credit refund | Blocked: "requires a saved customer" | N | Not Run |
| RET-010 | Store credit disabled by setting | allowStoreCredit=false | Store-credit option rejected | N | Not Run |
| RET-011 | Manager approval for return | Approval-required flow with manager PIN | Approved; approver recorded | P | Not Run |
| RET-012 | Owner PIN approves return | Owner PIN at return approval | Accepted (permission-based) | P | Not Run |
| RET-013 | Return numbering | Multiple returns | Distinct sequential R-xxxxxx | P | Not Run |
| RET-014 | Credit-customer return routes to credit memo | Return on CREDIT-type customer sale | QB document type CREDIT_MEMO queued | P | Not Run |
| RET-015 | Paid-sale return routes to refund receipt | Cash sale return | REFUND_RECEIPT queued and synced | P | Not Run |
| RET-016 | Returns list + status filter | Open /returns, filter by status | Correct rows per status | P | Not Run |
| RET-017 | Return detail view | Open a completed return | Lines, conditions/dispositions, refunds, approver shown | P | Not Run |
| RET-018 | Failed refund surfaced | Force QB push failure on a return | Refund/return status FAILED visible; document shows FAILED watermark | N | Not Run |

## QUO — Quotations

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| QUO-001 | Build quotation | Add products, set customer, save draft | Draft created with server-computed totals | P | Not Run |
| QUO-002 | Unit price read-only after add | Inspect line editor | Price displayed as text, not editable | P | Not Run |
| QUO-003 | Line total = qty × price − discount | Set qty 3 + 10% discount | Line "Total (3 × Rs. x)" matches server preview | P | Not Run |
| QUO-004 | Quantity not capped by stock | Qty above on-hand | Accepted (quotes may exceed stock) | P | Not Run |
| QUO-005 | Products grid mirrors POS | Compare cards/chips vs POS | Same layout, badges, category chips | P | Not Run |
| QUO-006 | No horizontal scroll on builder | 1280 and 1024 widths | No horizontal overflow anywhere | P | Not Run |
| QUO-007 | Sticky search/chips, scrollable products only | Scroll products list | Controls stay pinned; page body doesn't scroll; title scrolls away | P | Not Run |
| QUO-008 | Mark sent | Draft → Mark sent | Status SENT; share actions enabled | P | Not Run |
| QUO-009 | Revision on edit after sent | Edit a SENT quotation | New immutable revision (R2); history preserved | P | Not Run |
| QUO-010 | Accept / reject / cancel transitions | Exercise each action | Statuses update; invalid transitions rejected | P | Not Run |
| QUO-011 | Expiry handling | validUntil in past | Shown EXPIRED; conversion blocked | N | Not Run |
| QUO-012 | Convert to sale | Convert accepted quotation | Sale created with S-number; quotation CONVERTED_TO_SALE and linked | P | Not Run |
| QUO-013 | Convert checks stock | Quote qty > current stock, convert | Insufficient-stock error; nothing partial | N | Not Run |
| QUO-014 | Duplicate quotation | Duplicate an existing quote | New DRAFT with copied lines, new number | P | Not Run |
| QUO-015 | PDF download | Download quotation PDF | A4 document with lines, totals, letterhead | P | Not Run |
| QUO-016 | Share via public link | Generate share link, open logged out | Read-only public view renders | P | Not Run |
| QUO-017 | WhatsApp/email share logged | Share via channel | Share log records channel + status | P | Not Run |
| QUO-018 | Quotation numbering | Create several | Distinct sequential numbers; no reuse after deletion | P | Not Run |
| QUO-019 | Quotation list filters + search | Filter by status, search by customer/number | Correct rows | P | Not Run |
| QUO-020 | Quotation defaults from settings | Set default validity/terms, create new quote | validUntil and terms prefilled | P | Not Run |

## CUST — Customers

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| CUST-001 | Create customer with QB fields | Fill name + company, type, contacts, address, opening balance, resale no. | Created; profile shows all groups | P | Not Run |
| CUST-002 | Name required | Submit empty name | Validation error | N | Not Run |
| CUST-003 | Invalid email rejected | email "notanemail" | 400/client error | N | Not Run |
| CUST-004 | Opening balance must be numeric | "abc" in opening balance | Form blocks with message | N | Not Run |
| CUST-005 | POS type vs QB type independent | Set POS type CREDIT and QB type "Wholesale Trade" | Both persisted and displayed separately | P | Not Run |
| CUST-006 | Enable credit with limit | creditAllowed + limit 100000 | Persisted; enforced at POS (see PAY-009) | P | Not Run |
| CUST-007 | Credit limit hidden when credit off | Toggle creditAllowed off | Limit field hidden; stored null | P | Not Run |
| CUST-008 | Edit preserves unrelated fields | Change phone only | Other fields (incl. credit) untouched | P | Not Run |
| CUST-009 | Deactivate customer | Set inactive | Hidden from POS combobox; listed under Inactive filter | P | Not Run |
| CUST-010 | List search across fields | Search by phone fragment / company | Matching rows | P | Not Run |
| CUST-011 | Type + active filters | CREDIT + Active | Intersection only | P | Not Run |
| CUST-012 | Legacy address preserved | Pre-migration customer | Old single-line address appears in Street | P | Not Run |
| CUST-013 | Sync single customer to QuickBooks | Profile → Sync to QuickBooks | Queued; status chip transitions; QB id stored | P | Not Run |
| CUST-014 | Walk-in behavior preserved | Sale without customer, then store-credit return | Return blocked per RET-009 | P | Not Run |

## CIMP — Customer Bulk Import

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| CIMP-001 | Download customer template | Import → Template | .xlsx with 16 QB customer headers + samples | P | Not Run |
| CIMP-002 | Import official QB sample file (as .xlsx) | Upload converted sample | All 9 rows previewed; disclaimer row skipped | P | Not Run |
| CIMP-003 | "State " header with trailing space accepted | QB's own header quirk | State column parsed correctly | P | Not Run |
| CIMP-004 | Existing name matched as update | Row with existing customer name (case-insensitive) | Update badge; no duplicate on commit | P | Not Run |
| CIMP-005 | Duplicate names inside sheet flagged | Two rows same name | Second row errored | N | Not Run |
| CIMP-006 | Bad balance/date flagged per row | "abc" balance, bad date | Row errors; excluded from commit | N | Not Run |
| CIMP-007 | Re-import is idempotent | Commit same sheet twice | Second run all updates, zero creates | P | Not Run |
| CIMP-008 | Legacy .xls rejected with guidance | Upload original .xls | Friendly "re-save as .xlsx" error | N | Not Run |
| CIMP-009 | Imported defaults safe | Inspect an imported customer | POS type RETAIL, credit off | P | Not Run |
| CIMP-010 | Commit summary + failure list | Force one failing row | created/updated/failed counts + per-row error shown | P | Not Run |

## SUP — Suppliers (Vendors)

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| SUP-001 | Create vendor with QB fields | Name + company/contacts/address/opening balance/tax id | Created; profile shows Vendor details, Address, Opening balance, QuickBooks cards | P | Not Run |
| SUP-002 | Name is the only required field | Create with just a name | Succeeds | P | Not Run |
| SUP-003 | Duplicate name rejected (case-insensitive) | Create "acme" when "Acme" exists | 409 "vendor with this name already exists" | N | Not Run |
| SUP-004 | Rename collision rejected | Rename vendor B to vendor A's name | 409 | N | Not Run |
| SUP-005 | Opening balance up to 11+ digits | Balance 19,999,999,999 | Stored/displayed correctly (18,2 column) | P | Not Run |
| SUP-006 | Mark inactive | Toggle active off | Badge flips; excluded by Active filter | P | Not Run |
| SUP-007 | List search + filters + sort | Search phone; filter QB status; sort by company/newest | Correct result set and order | P | Not Run |
| SUP-008 | Delete unmapped vendor | Delete from profile | Confirm dialog → removed | P | Not Run |
| SUP-009 | Delete blocked while QB-mapped | Vendor mapped to QBO | Delete disabled with explanation; API 400 | N | Not Run |
| SUP-010 | Map QuickBooks vendor | Profile → Map vendor → search/select → confirm | Status CONNECTED; vendor name + last synced shown | P | Not Run |
| SUP-011 | Vendor search empty when QB disconnected | Disconnect QB, open mapping drawer | Empty list + guidance, not an error | P | Not Run |
| SUP-012 | Replace existing mapping warns | Change mapping on mapped vendor | Warning copy; replace succeeds | P | Not Run |
| SUP-013 | One QBO vendor per supplier | Map a QBO vendor already mapped elsewhere | 409 conflict | N | Not Run |
| SUP-014 | Unmap vendor | Unmap from profile | Status NOT_CONNECTED; delete becomes possible | P | Not Run |
| SUP-015 | Nonexistent vendor id | /suppliers/bad-id | Not-found state | N | Not Run |

## SIMP — Vendor Bulk Import

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| SIMP-001 | Download vendor template | Import → Template | .xlsx with 15 QB vendor headers + samples | P | Not Run |
| SIMP-002 | Import official QB vendor sample (.xlsx) | Upload converted sample | 9 rows preview; trailing disclaimer row skipped | P | Not Run |
| SIMP-003 | Huge/negative balances survive | Rows with −12,345,678,901 etc. | Imported without overflow | P | Not Run |
| SIMP-004 | Name match = update | Existing vendor name in sheet | Update, not duplicate | P | Not Run |
| SIMP-005 | In-sheet duplicate names flagged | Same name twice | Second row errored | N | Not Run |
| SIMP-006 | Re-import idempotent | Same sheet twice | Second run: 0 created | P | Not Run |
| SIMP-007 | Error rows excluded from commit button count | One bad row of five | Button reads "Import 4 vendors" | P | Not Run |
| SIMP-008 | Wrong-header sheet rejected | Sheet missing Name column | 400 with header guidance | N | Not Run |

## QB — QuickBooks Integration

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| QB-001 | Connect via OAuth | Connect → authorize sandbox → callback | Status Connected with company name/realm/currency | P | Not Run |
| QB-002 | Callback error surfaced | Deny authorization | Redirect shows failure notice; still disconnected | N | Not Run |
| QB-003 | Status card fields | Inspect connection card | Environment, company, realm id, last sync | P | Not Run |
| QB-004 | Disconnect | Disconnect button | Tokens revoked; page flips to Not connected | P | Not Run |
| QB-005 | Expired refresh token auto-deactivates | Invalidate refresh token, trigger any sync | Friendly "connection has expired — reconnect" once; status becomes Not connected; no raw invalid_grant anywhere | N | Not Run |
| QB-006 | Sync with QuickBooks — products | Run sync | Catalog pulled; created/updated/skipped counts logged | P | Not Run |
| QB-007 | Sync — customers pull-create | QBO customers missing locally | Created locally with full fields, linked, SYNCED | P | Not Run |
| QB-008 | Sync — vendors pull-create | QBO vendors missing locally | Created as suppliers, mapped CONNECTED | P | Not Run |
| QB-009 | Sync links exact-name matches | Local record matching QBO display name | Linked instead of duplicated | P | Not Run |
| QB-010 | Sync is idempotent | Run twice back-to-back | Second run: 0 created, all refreshed | P | Not Run |
| QB-011 | Vanished QBO vendor flagged | Delete/deactivate mapped vendor in QBO, sync | Supplier qbStatus ATTENTION; vendor card shows count; log row FAILED status | N | Not Run |
| QB-012 | All five status cards present | QuickBooks overview | Product / Customer / Vendor / Sales sync + Sync errors | P | Not Run |
| QB-013 | All entity cards animate during sync | Click Sync with QuickBooks | Product, Customer, Vendor cards show Syncing together; Sales card unaffected | P | Not Run |
| QB-014 | Party cards work while disconnected | Disconnect, view overview | Cards show local mapping counts (no error) | P | Not Run |
| QB-015 | Sale auto-pushes on completion | Complete a sale | PENDING→SYNCED within seconds; SALES_RECEIPT id in log | P | Not Run |
| QB-016 | Sales push failure visible + retryable | Break connection, sell, restore, retry | FAILED shown in errors card/log; retry succeeds | N | Not Run |
| QB-017 | Sync log covers all entity types | After full sync + a sale | Product pull, Customer pull, Vendor pull, Sale push rows with statuses | P | Not Run |
| QB-018 | Sync log filters | Filter Failed / Pending / Synced | Rows filtered accordingly | P | Not Run |
| QB-019 | Products page "Sync Products" still scoped | Run from QuickBooks→Products | Only product pull executes | P | Not Run |
| QB-020 | Manage actions gated | Accountant tries Sync/Disconnect | Buttons disabled / API 403 | N | Not Run |
| QB-021 | Background auto-pull runs | Wait one auto-pull interval (15 min) with QB connected | Catalog refreshed without user action; log row written | P | Not Run |
| QB-022 | Per-sale sync endpoint | POST /quickbooks/sync-sale/:saleId | That sale pushed; QBO doc id recorded | P | Not Run |
| QB-023 | Retry from sync log | POST /quickbooks/retry/:syncLogId on a FAILED row | Entity re-pushed; log updated | P | Not Run |
| QB-024 | Vendor search filters server-side | Type a term in the mapping drawer | Result list narrowed by DisplayName match | P | Not Run |
| QB-025 | Credit settlement pushed as QBO Payment | Settle a credit (invoice) sale | Payment created in QuickBooks against the invoice | P | Not Run |

## SET — Settings

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| SET-001 | Update tax rate reflects in POS | Change tax %, make a sale | New rate used in totals | P | Not Run |
| SET-002 | Letterhead fields on documents | Set company name/address/tax no. | A4 documents show updated letterhead | P | Not Run |
| SET-003 | Toggle store-credit refunds | Disable, attempt store-credit return | Blocked (RET-010) | P | Not Run |
| SET-004 | Return window setting respected | Set N days, test boundary sale | Day N eligible, day N+1 not | P | Not Run |
| SET-005 | Reset restores defaults | Settings → Reset | Defaults reapplied after confirm | P | Not Run |
| SET-006 | Settings persist per tenant | Change in tenant A, check tenant B | B unaffected | P | Not Run |
| SET-007 | Non-admin cannot open settings | Cashier hits /settings | Blocked (permission gate) | N | Not Run |
| SET-008 | Invalid tax rate rejected | −5 or 250 | Validation error | N | Not Run |
| SET-009 | Quotation defaults applied | Configure default quotation validity/terms | New quotations pick both up (see QUO-020) | P | Not Run |
| SET-010 | Invoice note saves and prints | Settings → Business → set Invoice note, save, open an invoice | Note appears below the footer line | P | Passed |
| SET-011 | Blank invoice note prints nothing | Clear the note, save, open an invoice | No note block rendered; footer unchanged | P | Passed |
| SET-012 | Invoice note is multi-line | Enter a 2-line note, save, open an invoice | Both lines render, line break preserved | P | Passed |
| SET-013 | Invoice note only on invoices | Set a note, open quotation / return / exchange documents | Note absent on all three | N | Passed |
| SET-014 | Invoice note escapes HTML | Enter `<script>alert(1)</script> A & B` | Rendered as literal text, no script execution | N | Passed |
| SET-015 | Invoice note length capped | Submit a note over 500 characters | Validation error, not persisted | N | Not Run |
| SET-016 | Existing tenant gets the new field | Load settings for a tenant saved before this field existed | Defaults merged in, note blank, no crash | P | Passed |

## DOC — Documents & Printing

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| DOC-001 | Sale A4 document renders | Open printable invoice for a sale | Items, totals, payments, letterhead correct | P | Not Run |
| DOC-002 | Customer block composes address | Sale for customer with street/city/state/zip/country | One joined "Bill to" address line; company + tax no. shown | P | Not Run |
| DOC-003 | Walk-in shows placeholder party | Sale without customer | "Walk-in customer" block | P | Not Run |
| DOC-004 | Return document | Print a completed return | Refund lines and totals correct | P | Not Run |
| DOC-005 | Quotation PDF via server | Download PDF | Generated (Puppeteer/Chromium) with valid layout | P | Not Run |
| DOC-006 | Tax number visibility toggle | Disable customer tax display setting | Tax number omitted from party block | P | Not Run |
| DOC-007 | Documents print light theme | Print from dark mode | White page, light tokens forced | P | Not Run |
| DOC-008 | Receipt for reprint | Reprint receipt from sale detail | Server receipt returned; falls back to client HTML if unavailable | P | Not Run |
| DOC-009 | Receipt record per sale + mark printed | Complete sale; GET /receipts/sale/:id; mark printed | Receipt exists; status flips to PRINTED | P | Not Run |
| DOC-010 | Attach customer to a receipt | POST /receipts/:saleId/customer | Customer linked for the reprint | P | Not Run |
| DOC-011 | Document template preview from settings | Settings → preview / sample PDF | Sample renders with current letterhead/toggles | P | Not Run |
| DOC-012 | Four signature placeholders render | Enable signature fields, open any document | Authorized signature, Checked by, Approved by, Customer signature — in that order | P | Passed |
| DOC-013 | Signature toggle hides all four | Disable signature fields, open a document | No sign-off row at all | N | Passed |
| DOC-014 | Signature chain on every doc type | Open quotation, invoice, return, exchange | All four blocks present on each | P | Passed |
| DOC-015 | Signature row fits A4 width | Print a document with signature fields on | Four equal columns on one row, no wrap or overflow | P | Not Run |
| DOC-016 | Uploaded signature/stamp fit their column | Upload a wide signature image, print | Image scales to column width, does not overlap "Checked by" | P | Not Run |

## ADM — Administration & Multi-Tenancy

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| ADM-001 | Provision fresh tenant | Run provision script with name/slug/users | Tenant + Main Branch + Register 1 + users created; credentials printed | P | Not Run |
| ADM-002 | Provisioned tenant starts empty | Log in as new owner | 0 products/customers/suppliers/sales everywhere | P | Not Run |
| ADM-003 | Provision refuses existing slug/name | Re-run same command | Aborts with clear message; nothing modified | N | Not Run |
| ADM-004 | Provision refuses duplicate email | Use an email that exists in another tenant | Aborts | N | Not Run |
| ADM-005 | Provision validates role and PIN format | Bad role / 3-digit PIN / duplicate PINs | Each aborts with specific message | N | Not Run |
| ADM-006 | Provisioned PINs work for approvals | New tenant owner PIN at discount prompt | Approves within that tenant only | P | Not Run |
| ADM-007 | Tenant data isolation — API | Tenant A token requests tenant B resource ids | 404/empty; never cross-tenant data | N | Not Run |
| ADM-008 | PINs are tenant-scoped | Demo manager PIN in new tenant's approval dialog | 401 Invalid manager PIN | N | Not Run |
| ADM-009 | Document numbering per tenant | Sales in two tenants | Each has its own S-000001 sequence | P | Not Run |
| ADM-010 | Create user via API | Owner POSTs /v1/users | User created in own tenant; can log in | P | Not Run |
| ADM-011 | QuickBooks connections per tenant | Connect tenant A only | Tenant B remains Not connected | P | Not Run |
| ADM-012 | Duplicate email on user create rejected | POST /users with an existing email | 4xx conflict/validation error | N | Not Run |
| ADM-013 | Invalid role on user create rejected | POST /users with role "SUPERADMIN" | 400 | N | Not Run |
| ADM-014 | Audit log records sensitive actions | Approve a discount / change settings; GET /audit-logs | Entries with actor, action, timestamp | P | Not Run |

## UI — Theme, Layout & Responsiveness

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| UI-001 | Dark mode toggles instantly | Toggle theme | All surfaces/tokens switch (not just scrollbar) | P | Not Run |
| UI-002 | Theme persists across reload | Set dark, reload | No flash of wrong theme (pre-paint script) | P | Not Run |
| UI-003 | System theme mode follows OS | Mode=system, flip OS preference | UI follows live | P | Not Run |
| UI-004 | Sidebar collapse persists | Collapse, reload | Stays collapsed; icons+tooltips shown | P | Not Run |
| UI-005 | Mobile nav drawer | <768px, tap header menu button | Drawer opens; closes on route change and Escape | P | Not Run |
| UI-006 | Header minimal on desktop | ≥768px | No hamburger, no branch/register chips; account menu holds branch/register info | P | Not Run |
| UI-007 | No horizontal scroll on core pages | 1024/1280/1440 widths: dashboard, POS, quotation builder, lists | Document never scrolls horizontally | P | Not Run |
| UI-008 | Tables scroll within cards | Narrow viewport on suppliers/customers/sales | Table scrolls inside card, not the page | P | Not Run |
| UI-009 | Empty states everywhere | Fresh tenant visits each list | Meaningful empty state + primary action, no spinners stuck | P | Not Run |
| UI-010 | Error toasts/banners recover | Kill API mid-session, then restore + Retry | Clear errors, successful recovery, no stale spinners | N | Not Run |
| UI-011 | Currency formatting consistent | Scan money displays | `Rs. 1,250.00` style everywhere; compact `mil` only on dashboard stats | P | Not Run |
| UI-012 | Keyboard focus visible | Tab through login/POS | Focus rings on interactive elements | P | Not Run |
| UI-013 | Command palette opens with Ctrl/Cmd+K | Press shortcut anywhere in the app | Palette opens; Escape closes | P | Not Run |
| UI-014 | Command palette navigates | Type "sup", pick Suppliers | Route changes; palette closes | P | Not Run |
| UI-015 | Reduced motion respected | Emulate prefers-reduced-motion | Entrance/chart animations neutralized | P | Not Run |
| UI-016 | Charts have accessible alternatives | Inspect dashboard charts | Accessible summaries / data-table views present | P | Not Run |

## SEC — Security

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| SEC-001 | All API routes require auth | Call each module root without token | 401 (except login/public quotation/QB callback/health) | N | Not Run |
| SEC-002 | Tenant header cannot spoof access | Valid token A + X-Tenant-Id of B | Server uses token's tenant; B data never returned | N | Not Run |
| SEC-003 | Whitelist validation rejects extra fields | POST with unknown properties | 400 "property should not exist" | N | Not Run |
| SEC-004 | SQL-ish input treated as data | Names like `Robert'); DROP TABLE--` in search/create | Stored/escaped safely; no error 500 | N | Not Run |
| SEC-005 | XSS strings rendered inert | Product/customer name `<img src=x onerror=…>` | Rendered as text everywhere (list, POS, documents) | N | Not Run |
| SEC-006 | Approval tokens single-purpose | Tamper token payload / reuse across tenants | Rejected | N | Not Run |
| SEC-007 | Public quotation link scope | Fetch other ids/tokens on public route | Only the shared quotation readable; guesses 404 | N | Not Run |
| SEC-008 | Secrets never in client bundle | Inspect built web assets | No QBO secrets/DB URLs present | N | Not Run |
| SEC-009 | Upload endpoints validate content type | Product image endpoint with non-image | Rejected; nothing stored | N | Not Run |
| SEC-010 | Rate behavior on repeated failed PINs | Hammer approve endpoint with bad PINs | Consistent 401s, no lockout bypass, no timing leak of valid PINs (best-effort) | N | Not Run |
| SEC-011 | Upload filename traversal blocked | Upload image named `../../evil.png` | Stored under a safe generated key; no path escape | N | Not Run |
| SEC-012 | CORS locked to configured origin | Cross-origin browser request to the API | Blocked by CORS for non-configured origins | N | Not Run |

---

### Coverage summary

| Module | Cases | Module | Cases |
|---|---|---|---|
| AUTH | 15 | CUST | 14 |
| PERM | 9 | CIMP | 10 |
| DASH | 20 | SUP | 15 |
| PROD | 27 | SIMP | 8 |
| PIMP | 13 | QB | 25 |
| POS | 33 | SET | 9 |
| PAY | 22 | DOC | 11 |
| SALE | 11 | ADM | 14 |
| RET | 18 | UI | 16 |
| QUO | 20 | SEC | 12 |

**Total: 322 test cases** (≈60% positive / 40% negative).

### Notes for automation

- IDs are stable — name Playwright specs after them (e.g. `pos.spec.ts` →
  `test('POS-005 typed quantity clamps to stock', …)`).
- Seed-dependent cases (AUTH-007, ADM-*) need the dev seed or the provisioning
  script as fixtures; QB-* cases need a QuickBooks sandbox connection and are
  best tagged `@quickbooks` so they can be excluded from CI without secrets.
- Concurrency cases (PAY-014, PAY-015) are API-level tests, not browser tests.
