# AxloPOS — System Test Cases

Master test-case inventory for the Hardware POS system (web + API). Each case
has a stable ID for traceability into automated Playwright specs.

- **Type**: `P` = positive (happy path), `N` = negative (error/guard path)
- **Status**: `Not Run` → `Pass` / `Fail` / `Blocked` / `Automated` (update as
  cases are executed manually or scripted)
- Unless stated otherwise, cases assume the seeded demo tenant and the roles
  the hardware template staffs: Owner (email login), Salesperson (email
  login) and Cashier (PIN). Manager and Accountant are enum tiers with no
  seeded user since 2026-08-17. Salesperson is owner-equivalent — every gate
  the owner clears must open for it too — and, since D108, is linked to the
  hardware template's `SALESPERSON` role row and offered by no other template.
  The Retail template (D120) staffs Owner and Cashier only (`GENERAL_ROLE_TEMPLATES`,
  no Salesperson); PROD-031…047, EXC-T-008…012, STK-* and RPT-* assume a provisioned
  `RETAIL` tenant unless stated.

Modules: [AUTH](#auth--sessions) · [PERM](#perm--roles--permissions) ·
[DASH](#dash--dashboards) · [PROD](#prod--products--categories) ·
[PIMP](#pimp--product-bulk-import) · [POS](#pos--point-of-sale) ·
[PAY](#pay--payments--credit) · [DISC](#disc--discount-basis) ·
[MARK](#mark--accounting-for-a-credit-invoice) ·
[SALE](#sale--sales-history) ·
[RET](#ret--returns--refunds) · [EXC](#exc--exchanges) · [QUO](#quo--quotations) ·
[CUST](#cust--customers) · [CIMP](#cimp--customer-bulk-import) ·
[SUP](#sup--suppliers-vendors) · [SIMP](#simp--vendor-bulk-import) ·
[QB](#qb--quickbooks-integration) · [SET](#set--settings) ·
[DOC](#doc--documents--printing) · [RSV](#rsv--table-reservations--calendar-d47) ·
[OTBL](#otbl--open-tables-d49d50) ·
[BSPL](#bspl--bill-splitting-by-item-d51) ·
[STK](#stk--stock-takes-d132) · [RPT](#rpt--retail-reports-d129d131) ·
[ADM](#adm--administration--multi-tenancy) ·
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
| AUTH-007 | PIN login endpoint removed (D48) | POST /v1/auth/pin-login | 404 — the route does not exist | N | Passed |
| AUTH-008 | Cashier signs in with email + password (D48) | Cashier credentials in the login form | Logged in; lands on dashboard | P | Passed |
| AUTH-009 | Login page has no PIN affordance (D48) | Inspect /login | No PIN field or PIN button rendered | N | Passed |
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
| PERM-010 | Salesperson has owner-level user management | Salesperson calls GET /v1/users | 200 with the tenant's users | P | Not Run |
| PERM-011 | Salesperson may permanently delete a supplier | Salesperson opens supplier profile, deletes | Delete succeeds where a manager gets 403 | P | Not Run |
| PERM-012 | Salesperson may manage products | POST /v1/products with salesperson token | Product created | P | Not Run |
| PERM-013 | Salesperson reaches owner-only QuickBooks routes | Salesperson calls GET /v1/quickbooks/connect | Not 403 (role gate allows owner-level roles) | P | Not Run |
| PERM-014 | Salesperson nav matches the owner's | Log in as salesperson | Same nav entries as PERM-001 | P | Not Run |
| PERM-015 | Salesperson discount needs no approval | Apply a 50% line discount as salesperson | Accepted with no manager PIN prompt (unlimited ceiling) | P | Not Run |
| PERM-016 | Salesperson resolves from its own role row (D108) | Owner reads GET /v1/users/{salesperson}/effective-permissions | `source` is `DATABASE` and the permission list equals the owner's; the cashier's is shorter | P | Not Run |

## DASH — Dashboards

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| DASH-001 | Admin KPI band shows 5 cards | Owner opens dashboard | Net Sales, Gross Profit, Credit Receivable, Total Inventory Value, Open Quotations | P | Automated |
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
| DASH-021 | Receivable card counts every unsettled balance | Read /dashboard/stats, complete a credit sale, read again | `outstandingReceivable` rises by exactly the sale total | P | Automated |
| DASH-022 | An account payment comes off the receivable at once | Part-pay an account, then clear it | The receivable drops by the part payment immediately, and by the full amount once cleared | P | Automated |
| DASH-023 | Receivable is not windowed | Switch the dashboard range (Today → 1Y) | Credit Receivable is unchanged — money owed does not stop being owed at midnight | P | Not Run |
| DASH-024 | Receivable card deep-links to who owes | Click Credit Receivable | Customers page opens filtered to customers with credit outstanding | P | Not Run |

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
| PROD-028 | Sold out is a switch, not a count (D101) | Restaurant owner marks a dish sold out, then available again | `soldOutAt` set then cleared; the POS card greys out and comes back; a repeat 86 keeps the original timestamp | P | Not Run |
| PROD-029 | The 86 switch refuses stock-governed kinds (D101) | PUT /v1/products/:id/availability on a STOCK_ITEM or a booking kind | 400 `PRODUCT_AVAILABILITY_STOCK_GOVERNED` naming what governs it; a waiter/cashier may 86 a dish but not edit the catalogue | N | Not Run |
| PROD-030 | Product wizard enforces name and SKU limits | Type past 200 characters in Product name and past 80 in a SKU; leave a variation option blank; give two variations one name | Typing stops at the cap; the counter appears from 160 characters and reads 200 / 200 in the warning colour; a restored draft or an older row over the cap is refused with "Product name is limited to 200 characters." / "SKU is limited to 80 characters."; "Option needs a name."; "Variation names must be unique." | N | Not Run |
| PROD-031 | Retail template provisions with the clothing categories (D120) | Run `provision-tenant.ts --business-type RETAIL` without `--with-samples`; log in as the new owner | Profile is `LOCAL` inventory + `NONE` accounting; no QuickBooks rail entry; categories are exactly Menswear, Womenswear, Kidswear, Footwear, Accessories in that order and Footwear has no size scale; zero products; the only roles offered are Owner and Cashier | P | Not Run |
| PROD-032 | Clothing sample pack builds the whole variant chain (D120) | Provision RETAIL with `--with-samples`; open Cotton T-Shirt and Denim Jeans; run provisioning again | T-Shirt has Size S/M/L/XL × Colour Black/White/Navy = 12 variants named from their options (M / Black), not from the SKU `TSHIRT-M-BLACK`, with M / Black the single default; Jeans has waist 30/32/34/36 with 32 default; every variant has its own branch stock row (10 / 6) and a distinct barcode; the parent price is 0 because variants own the price; the second run adds nothing | P | Not Run |
| PROD-033 | A variant product's stock is the sum of its sizes (D121) | Product with four active variants holding 22 units between them while `Product.quantityOnHand` reads 350; GET /v1/products/sellable | `availableQuantity` is `22.000`, derived from the variant rows, never the 350 mirror; `stockState` is OUT only when every size is out, LOW when no size is IN_STOCK (each size against its own reorder point), otherwise IN_STOCK | P | Not Run |
| PROD-034 | The sell cap asks the chosen size, not the total (D121) | In POS pick the Medium (2 on hand) of a shirt whose siblings hold 10; type 3; then POST /sales/complete with quantity 3 for that variant | Till clamps the line to 2; the server refuses "Insufficient stock for <product>" and moves nothing — a sibling with plenty of stock does not rescue an oversold size; the same wording as the product path | N | Not Run |
| PROD-035 | Option library definitions carry codes and swatches (D125/D125a) | Open /products/attributes (URL) → New attribute "Colour": options Black `BLK` #000000, Navy `NVY` #1F2A44, "All categories"; Save; add a second "Colour"; add options `black` and `BLACK`; enter swatch `red` | First saves and lists its options in declared order with 0 products mapped; the duplicate name is 409 `ATTRIBUTE_DEFINITION_EXISTS` "An attribute named "Colour" already exists for this tenant." (another tenant may use the name); `black`/`BLACK` refused 400 `ATTRIBUTE_OPTION_DUPLICATE` naming both names and the one code they normalise to; the swatch reads "Use #RRGGBB, for example #1A1A1A." | N | Not Run |
| PROD-036 | Mapping a dimension to the library is optional and additive (D125) | PUT /v1/products/:id/variations with `attributeDefinitionId` on Size and `attributeOptionId` on each option; leave a second product unmapped; then link an option to a different definition than its dimension, and to another tenant's definition | Links round-trip on GET; omitting the field leaves a mapping alone and `null` clears it; the unmapped product sells and prices exactly as before; both bad links are refused; the library page shows the definition as used by 1 product and its Delete reads "Unmap it from every product before deleting it." | P | Not Run |
| PROD-037 | A mapped library entry cannot be retired (D125) | DELETE /v1/attribute-library/:id while a dimension points at it; PATCH its `options` dropping one a product option uses; unmap, then delete | 409 `ATTRIBUTE_DEFINITION_IN_USE` naming the dimension and option counts; 409 `ATTRIBUTE_OPTION_IN_USE` naming the option and how many product options use it; after unmapping the delete is 204 and the products keep their own dimensions (FK is SET NULL, guarded by the service) | N | Not Run |
| PROD-038 | SKU is generated when omitted, one sequence number per variant (D125) | POST /v1/products/:id/variants:batch for a product in category Apparel, rows omitting `sku`, one option mapped to library code `BLK`; then a batch where one row types `MY-SKU` and its neighbour omits it; then a batch whose generated value collides with a hand-typed SKU | Generated SKUs read `APPAREL-<SEQ>-BLK`, each variant with its own sequence number; the typed SKU is kept and its neighbour still generated; the collision is retried onto the next number, never duplicated (`@@unique([tenantId, sku])`); a second tenant starts at 1 | P | Not Run |
| PROD-039 | Barcode allocation needs a prefix; a typed code is validated by shape (D125) | Retail tenant with no prefix: create a variant leaving Barcode blank; set In-store barcode prefix `2001` on /products/barcodes and retry; then type `2990001000000` (wrong check digit) and `ABC-123-XYZ` | Blank is refused 400 `BARCODE_PREFIX_NOT_CONFIGURED` "No barcode prefix is configured for this workspace…"; after the prefix a 13-digit EAN-13 under `2001` with a valid check digit is issued as `barcodeSource` INTERNAL; a prefix outside the GS1 in-store range is `BARCODE_PREFIX_INVALID`; the 13-digit code is refused `BARCODE_CHECK_DIGIT_INVALID` "…is 13 digits but its check digit is wrong…"; the Code 128 value is accepted as typed; the same barcode on a second variant is refused as a duplicate | N | Not Run |
| PROD-040 | Barcode audit lists only the problems (D125) | Open /products/barcodes (URL) on a tenant holding a valid EAN-13, an invalid-check-digit one and a supplier CODE128 | Summary shows scanned, "With a barcode" and "Wrong check digit" counts; only the `INVALID_CHECK_DIGIT` row is listed with SKU, product and source ("Predates provenance tracking" when null); the CODE128 is counted, not listed; a clean catalogue reads "Every barcode checks out." | P | Not Run |
| PROD-041 | Reissue is explicit and never touches a supplier code (D125) | POST /v1/barcodes/reissue with one INTERNAL invalid variant; then a selection that includes a SUPPLIER row; then `variantIds: []`; then a variant with no barcode | The internal row gets a fresh valid EAN-13 under the tenant prefix and the audit log records the OLD value; the mixed selection is refused wholesale 400 `SUPPLIER_BARCODE` and nothing changes; the empty list is `NO_VARIANTS_SELECTED` (there is no "fix everything"); the bare variant is `NOTHING_TO_REISSUE` | N | Not Run |
| PROD-042 | Brand is a per-tenant entity (D133) | POST /v1/brands "Nike"; again with " Nike "; rename it to "Nike Inc"; set a product's brand; reload the products list and filter | The second is 400 `There is already a brand called "Nike"` (trimmed); the rename shows on every product because the link is an id; the products list shows a "Filter by brand" picker only once a brand exists and `GET /v1/products?brandId=` returns that label only; `productCount` says how many carry it; another tenant may also create "Nike" | P | Not Run |
| PROD-043 | Brands archive, never delete (D133) | PATCH /v1/brands/:id `isActive:false`; GET /v1/brands then `?includeArchived=true`; open a product that carried it; PATCH `isActive:true`; PATCH a product with a brand id from another tenant | Archived brand is absent from the default list and the wizard picker, present with includeArchived; the product still shows it (link kept, no DELETE route exists); restore works through the same route; the foreign brand id is 400 "Brand … does not belong to this tenant"; on a product, an absent `brandId` leaves the brand alone and `""` clears it | P | Not Run |
| PROD-044 | A measured product must name its unit (D134/D134c) | Retail wizard → Pricing: choose "By weight or measure — 0.75, 1.5", leave Unit blank, Save; then enter `kg`; then create a "By the piece" product; open the wizard on a hardware or restaurant tenant | Blank is refused "A product sold by weight or measure needs a unit — for example kg, g or L."; with `kg` the helper reads `The till will ask "How many kg?" and price the amount typed…`; the piece product needs no unit and sends `unitOfMeasure: null`; the control is absent where `catalogue.measuredGoods` is off | N | Not Run |
| PROD-045 | Switching WHOLE ⇄ DECIMAL is allowed and converts nothing (D134b) | On a RETAIL workspace (hardware is refused, PROD-048): PATCH /v1/products/:id `{quantityType:"DECIMAL"}` on a product with no stored unit; again with `unitOfMeasure:"kg"`; PATCH `{unitOfMeasure:""}` on it; PATCH `{name:"Rice"}`; PATCH back to WHOLE | First refused 400 (same message as PROD-044); second accepted; clearing the unit while DECIMAL is refused; the name-only update leaves both fields alone; back to WHOLE keeps the stored unit and 100 on hand stays 100 — no quantity is converted | P | Not Run |
| PROD-046 | A retail tenant starts on the clothing list and may replace it (D64/D138) | Retail wizard → Business details on a workspace that has configured nothing; then PUT /v1/products/:id with `attributes: { allergens: "nuts" }` | Fields offered are Material, Fit (Regular/Slim/Relaxed/Oversized), Care instructions, Gender (Men/Women/Unisex/Boys/Girls), Season, all optional — the RETAIL descriptor's own list, served because nothing is stored; `allergens` is refused as an unknown key until the tenant adds it in Settings → Business details (PROD-051) | P | Not Run |
| PROD-047 | The Taxable toggle names the tenant rate (D122) | Retail wizard → Details with the tenant rate at 18%: Taxable on; Taxable off; set the rate to 0 in Settings → Business and reopen | Helper reads "Tax applies at 18%." / "Zero-rated — no tax is charged on this product." / "This shop's tax rate is 0%, so nothing is charged yet. Set it in Settings → Business."; a product saved with Taxable off is untaxed on a real sale and its line records `taxRatePercent` 0.00 | P | Not Run |
| PROD-048 | Measured goods are refused outside RETAIL by the server (D134e) | As a hardware owner POST /v1/products with `quantityType: "DECIMAL"`; PATCH an already-DECIMAL hardware product's name only, then set it back to WHOLE; repeat the create on a RETAIL workspace | Hardware create is 400 `MEASURED_GOODS_NOT_OFFERED` (the wizard hides the control, the API refuses the assertion); the rename and the switch to WHOLE both succeed — the rule is "you may not assert measured here", not "no measured row may exist"; the RETAIL create is 201 | N | Not Run |
| PROD-049 | Variations come from the attribute library (D125/5.11) | On a RETAIL workspace with a "Size" definition bound to Apparel and an unbound "Colour": Add Product → category Apparel → Variations; pick Size and tick S, M; change the category; also add a hand-typed "Fit" | The picker offers Size and Colour (unbound applies everywhere) and not another category's scales; ticked options become the rows, nothing is adopted wholesale; after the category change a definition it no longer offers is unmapped (`attributeDefinitionId` null) while the typed options stay; the saved product carries the ids on Size and none on Fit; a hardware workspace with no library still gets the free-text fields | P | Not Run |
| PROD-050 | Products search collapses whitespace and can be cleared; categories live on the tab (D137) | Type "rice  curry" (two spaces) in the products search; press the Clear control; look for a Categories button in the header and open the Categories tab | The list matches "Rice Curry"; the field has the accessible name "Search products" and empties on Clear; there is no Categories button in the header and the tab reaches /products/categories | P | Not Run |
| PROD-051 | A retail tenant defines its own business details (D138) | Settings → Business details on a RETAIL workspace: rename Material's label to Fabric, remove Gender (nothing records it), add a Text box "Batch code", add a Dropdown "Storage" with Chilled/Frozen, add a Calendar date "Expiry", Save; reopen Add Product → Business details | Save succeeds; the tab reloads with the six fields and drops the "suggested fields for your business type" note; the wizard's step 2 renders Fabric (text), Fit, Care instructions, Season, Batch code (text), Storage (select with exactly Chilled/Frozen) and Expiry (`type="date"`); `material` is still the stored key, so a product saved before the rename still shows its value | P | Not Run |
| PROD-052 | A business detail in use cannot be taken away (D138) | On the workspace from PROD-051 set a product's Storage to Chilled and save; then in Settings → Business details remove the Storage field and Save; then remove only the Chilled choice and Save; then change Storage's type to Text box and Save; then remove Batch code, which nothing records | Each of the first three is refused with the server's own wording and the count — e.g. `1 product(s) still record "Storage". Clear it on those products before removing the field.` / `1 product(s) are set to "Chilled" for Storage.` — and the editor keeps the operator's edit rather than reloading; removing Batch code succeeds, proving the guard is not "refuse every removal" | N | Not Run |
| PROD-053 | An empty business-details list is a real answer (D138) | Settings → Business details: remove every field (on a workspace whose products record none) and Save; then open Add Product | Save succeeds with "The Add Product form now skips the business details step."; the wizard shows four steps, not five, and no Business details step; the stepper numbering is consistent | P | Not Run |
| PROD-054 | A calendar date is validated as a real day (D138) | With an Expiry date field configured, PUT /v1/products/:id with `attributes: { expiry: "2026-02-31" }`; then `"09/09/2026"`; then `"2026-9-9"`; then `"2026-09-09"` | The first three are refused — 31 February does not exist, and the other two are not the stored notation — and the fourth is accepted; the refusal names the field | N | Not Run |
| PROD-055 | Business details are RETAIL only, on the server as well as the screen (D138/D56) | As a hardware owner GET /v1/products/business-details and PUT it; repeat as a restaurant owner; then open Settings on both | Both verbs are refused 400 `BUSINESS_DETAILS_NOT_CONFIGURABLE` for both business types; neither workspace shows a Business details tab; the hardware wizard still shows no attributes step and the restaurant one is unchanged | N | Not Run |
| PROD-056 | A stored list stops being read once the workspace is no longer retail (D138) | Configure a list on a RETAIL workspace, change its business type to HARDWARE, open Add Product; change it back to RETAIL | Hardware serves its own (empty) schema and the stored list is ignored, not enforced; changing back restores the tenant's list intact — it was never deleted | N | Not Run |
| PROD-057 | The Inventory tab bar shows only the sub-surfaces a workspace has (D139) | Open /products on a RETAIL workspace, then on a HARDWARE one, then on a RESTAURANT one; on each read the tab row | Retail shows all seven — Products, Categories, Promotions, Attributes, Barcodes, Stock, Purchases; hardware shows the same WITHOUT Attributes; restaurant shows them without Attributes AND without Barcodes. Products / Categories / Promotions and the two disabled placeholders are present in every case, so no bar is ever empty | P | Not Run |
| PROD-058 | Hiding a catalogue tab removes no route and no API (D139) | As a restaurant owner navigate directly to /products/attributes and /products/barcodes by URL; then GET /v1/attribute-library | Both pages still render and the API still answers — D125 made the library shared core on permission, not on business type, and D139 hides a tab rather than gating an authority. The tab row on those pages simply has no tab highlighted | N | Not Run |
| PROD-059 | Retail's sale document is the thermal bill, not an A4 sheet (D140) | On a RETAIL workspace open a completed sale; then run a sale through POS → Payment and complete it | The sale page offers **Thermal receipt** and no **Print A4 bill**; the payment screen shows no “Print A4 bill after payment” toggle and completing the sale opens no A4 print window. On a HARDWARE workspace both are still there, unchanged | P | Not Run |
| PROD-060 | Retail keeps the letterhead its quotations need (D140) | On a RETAIL workspace open Settings → Branding, then Layout, then Preview | Branding still offers logo, accent colour, signature and stamp; Layout shows the A4 page size, margins and column toggles **and** a “What prints on the bill” summary; Preview shows the bill preview with roll calibration **and** the A4 document chooser. The chooser offers Quotation, Return and Exchange but **not** Invoice / Bill | P | Not Run |
| PROD-061 | The bill change reaches retail and nobody else (D140) | Repeat PROD-059 and PROD-060 on a HARDWARE workspace and on a RESTAURANT one | Hardware is completely unchanged — A4 bill button, A4 payment toggle, A4 Layout, A4 Preview with Invoice / Bill. Restaurant is completely unchanged — no A4 anywhere, no letterhead controls, bill preview only | N | Not Run |
| PROD-062 | The bill preview shows the workspace's own trade (D141) | Settings → Preview on a RETAIL workspace; then on a RESTAURANT one | Retail's bill sample lists clothing and groceries (Cotton Shirt, Basmati Rice) with a discount and tax but **no service charge and no table number**; restaurant's still lists its menu WITH a service charge and table M1/04. Neither shows the other's | P | Not Run |
| PROD-063 | An unconfigured letterhead is neutral, never another trade (D141) | On a workspace with the Business name field left blank, Settings → Preview → Quotation; then set the Business name and refresh the preview | The blank case shows the tenant's registered name (or “Your Business” if it has none) and **never “Hardware POS”**; once a business name is saved, the preview shows that instead | P | Not Run |
| PROD-064 | The A4 preview shows the workspace's own trade (D142) | Settings → Preview → Quotation on a RETAIL workspace; then on a HARDWARE one; then on a GENERAL one | Retail lists clothing and groceries (Cotton Shirt, Basmati Rice) and **no** hardware goods; hardware lists exactly what it always did (Portland Cement, TMT Steel Bar, all eight, with their SKUs when the SKU column is on); general lists neutral “Standard Item” filler and neither trade | P | Not Run |
| PROD-065 | A vertical that declares no sample goods gets filler, not another trade (D142) | Inspect the preview on any workspace whose domain declares no `sampleItems` | “Standard Item 1”… with realistic prices, a pack line and the discount/tax rows — never another vertical's goods. This is the guard that stops the original defect being rebuilt one level down for every future vertical | N | Not Run |

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
| POS-034 | Invoice date selector position and default | Open POS, view the cart panel | A date selector sits directly above the customer dropdown, pre-filled with today | P | Not Run |
| POS-035 | Backdate a sale from the cart | Set the invoice date to an earlier day | Field shows the picked date and a "Backdated" marker | P | Not Run |
| POS-036 | Invoice date survives the payment round-trip | Pick a past date, go to Payment, return to the cart | The picked date is still selected | P | Not Run |
| POS-037 | Forward dating blocked in the picker | Try to pick tomorrow | The picker refuses it (max = today) | N | Not Run |
| POS-038 | Invoice date resets after a completed sale | Complete a backdated sale, start a new one | The selector is back to today | P | Not Run |
| POS-051 | A sold-out dish cannot be rung up (D101) | Search a dish the seed ships 86'd on the counter POS | The tile is disabled and says sold out; the round refuses the item server-side | N | Not Run |
| POS-052 | The orders queue is silent; readiness is a count (D114/D118) | Bump a takeaway ticket while the Orders page is open | The Ready tab's count rises and the row moves; no sound plays anywhere but the kitchen | P | Not Run |
| POS-053 | Cancelling is the queue's verb (D116) | Cancel a takeaway from the Orders page; try to find Cancel on the kitchen board | The order is cancelled through the takeaway status machine and its ticket leaves the pass; the board offers no Cancel | P | Not Run |
| POS-054 | Payment settles without handing over (D117) | Take payment for a takeaway in the counter popup | The session closes into a Sale (POST /restaurant/takeaway/:profileId/settle, idempotent); the order still reads Pending / Preparing / Ready until Handed over is pressed by a hand | P | Not Run |
| POS-055 | No Completed tab on the counter's queue (D117) | Open the Orders page as the cashier | Tabs are All Orders · Pending · Preparing · Ready · Handed over · Cancelled; there is no Completed tab — a closed dine-in shell is reachable only under All Orders or an old `?status=COMPLETED` link | N | Not Run |
| POS-056 | Each sale line snapshots the rate it was charged (D122) | Tenant rate 18%; sell one taxable product and one with Taxable off, with a 10% order discount; change the rate to 20%; reopen the sale | Tax is charged only on the taxable line and the exempt line's share of the order discount leaves the base too; `SaleItem.taxRatePercent` is 18.00 on the taxable line and 0.00 (never null) on the exempt one; after the rate change the old sale still reads 18.00 | P | Not Run |
| POS-057 | A promotion's saving sits on the free line and is frozen (D123) | Active "buy 2 shirts get 1 tie free"; ring 2 shirts at 1,000 and 1 tie at 500; complete; rename then delete the promotion and reopen the sale; ring the basket again with a manual 10% line discount on the tie | Total 2,000 with tax on 2,000; the tie carries `promotionDiscountAmount` 500, `lineTotal` 0, `promotionId` and `promotionNameSnapshot`; the sale still names the promotion after rename/delete; with the manual discount the badge leaves the tie, the till warns which promotion "would have taken" what, and at most one of `discountAmount` / `promotionDiscountAmount` is non-zero on the line; till preview and server total agree | P | Not Run |
| POS-058 | A cart-level amount off is an order discount (D126) | FIXED_AMOUNT_DISCOUNT "Rs 1,000 off" with an empty item list and `minimumSpend` 10,000; ring 12,600 of goods; then a 9,000 basket; then try the same promotion with a non-BUY item, and `minimumSpend` on a PERCENTAGE_DISCOUNT | 12,600 → 11,600: the footer shows the discount under the promotion's own name, not under "Order discount"; tax is unchanged (computed before it); `Sale.promotionOrderDiscountAmount` 1,000 with `promotionOrderNameSnapshot`; the 9,000 basket gets nothing; the threshold is measured after line promotions and excludes manually discounted lines; creation is refused "FIXED_AMOUNT_DISCOUNT items must all be BUY items, or the list must be empty for a cart-level discount." and "minimumSpend applies only to FIXED_AMOUNT_DISCOUNT, not PERCENTAGE_DISCOUNT." | P | Not Run |
| POS-059 | Cart lines are keyed by variant (D120/D121) | Add a shirt's Medium, then its Large, then Medium again; tap a product with an `isDefault` size; tap one whose default is sold out | Two lines (Medium ×2, Large ×1), never one line of 3; the default size quick-adds without the "Choose an option" dialog; a sold-out default opens the picker with that size reading "Out of stock"; a product with one sellable option adds it without asking | P | Not Run |
| POS-060 | Weighed goods ask for the amount (D134/D134b) | On a RETAIL workspace (D134e): Rice: DECIMAL, unit kg, Rs 200/kg, 5 kg on hand; tap the card; type `0.750`; then try `0`, a fourth decimal place, and `6` | "How many kg?" opens with "Line total:" Rs 150.00 computed by the cart, not the keypad; Add is disabled at 0; the fourth decimal is ignored; 6 reads "Only 5 kg in stock."; Cancel adds nothing; the confirmed line is 0.750 kg, the server stores 0.750 exactly and the receipt prints `0.75 kg` | P | Not Run |
| POS-061 | Quantity promotions ignore a measured line (D134a) | On a RETAIL workspace (D134e): BUY_X_GET_Y naming Rice and a PERCENTAGE_DISCOUNT on Rice; ring 0.75 kg beside two shirts inside a bundle | The BOGO yields no claim on the rice and no reward is asked for; the percentage discount applies to it; the shirts still win their bundle; till preview and server charge agree | N | Not Run |
| POS-062 | An unbilled order reads Unpaid; only what was never owed reads Not tracked (D137) | Submit a dine-in order and leave the table unbilled; place a takeaway and do not settle it; cancel a third order; view a third-party order; then open the Orders page with the Unpaid chip | The unbilled dine-in and the unsettled takeaway carry an Unpaid badge and appear under Unpaid; the cancelled and third-party rows carry a "Not tracked" badge in the list AND in the detail drawer, never a bare "—"; a settled takeaway (D117) reads Paid from its sale | P | Not Run |

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
| PAY-008 | Credit blocked without customer | Balance>0, no customer selected | Rejected naming the missing customer (checked before the due date) | N | Automated |
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
| PAY-019 | Part payment settles no invoice | Two credit sales for one customer, pay half the account | Account balance drops; BOTH invoices still read Credit — not even the oldest is settled | P | Automated |
| PAY-020 | Clearing the account pays every invoice on it | Pay the full account balance | All invoices outstanding at that moment flip to Paid together | P | Automated |
| PAY-021 | Overpayment on the account rejected | Payment greater than the account balance | 400; balance unchanged | N | Automated |
| PAY-022 | Payment against a cleared account rejected | POST /payments for a customer who owes nothing | 400 "nothing outstanding" | N | Automated |
| PAY-023 | Due date required when a balance remains | Complete a credit/partial sale with no `paymentDueDate` | 400; message names the due date | N | Automated |
| PAY-024 | Due date rejected on a fully paid sale | Complete a fully paid sale carrying a `paymentDueDate` | 400 — nothing is outstanding to fall due | N | Automated |
| PAY-025 | Due date stored on the sale | Complete on credit with a due date, read the sale | `paymentDueDate` returned as given | P | Automated |
| PAY-026 | Due date before the invoice date rejected | `paymentDueDate` earlier than `saleDate` | 400 | N | Automated |
| PAY-027 | Instalments each kept as their own record | Two part payments against one account | Two Payment rows with their own date/time, method and reference, neither attached to a sale | P | Automated |
| PAY-034 | Credit warning appears as the order grows | Credit customer, raise a quantity in the payment page order summary until the total passes their limit | Warning appears live with available vs needed; Complete Payment disables — without pressing it. The credit panel is the ONLY place it is stated; no duplicate in the footer notice | P | Not Run |
| PAY-035 | Credit warning clears when payment covers it | With the warning showing, switch to Partial and enter enough to bring the balance under the limit | Warning clears; Complete Payment re-enables | P | Not Run |
| POS-046 | Non-stock-tracked products are marked on the card | Browse the POS grid | Cards carry a neutral badge and caption naming the item type — "Non-Inventory" or "Service" — worded exactly as the products list and product page do, not a red Out of Stock | P | Not Run |
| POS-047 | Per-unit fixed discount toggle | Item discount dialog, pick Fixed amount | An "Off the line" / "Off each unit" toggle appears; picking Percentage hides it | P | Not Run |
| POS-048 | Per-unit preview shows the arithmetic | 3 × Rs. 1,000, Rs. 100 off each unit | Preview reads "(Rs. 100.00 × 3)" and -Rs. 300.00 before Apply | P | Not Run |
| POS-049 | Reopening keeps the basis | Apply a per-unit discount, reopen the dialog | Still on "Off each unit" with the same amount | P | Not Run |
| POS-050 | Per-unit crosses the approval limit sooner | Cashier applies an amount that is within limit whole-line but over it per unit | Button changes to "Request approval"; the manager dialog names the per-unit amount | N | Not Run |
| POS-041 | Non-stock-tracked products are sellable | Add a NonInventory or Service product (e.g. POL-1976) to the cart | No "Only 0 in stock" warning, no cart-wide stock banner, and Proceed to Payment is enabled | P | Not Run |
| POS-042 | One untracked item does not block a mixed cart | Cart with an in-stock Inventory item and a NonInventory item | Checkout proceeds; the untracked line raises no warning | P | Not Run |
| POS-043 | Sold-out Inventory is still blocked | Add an Inventory product at 0 on hand | "Only 0 in stock", cart banner shown, Payment blocked | N | Not Run |
| POS-044 | Enter in search honours the stock guard | Type a sold-out Inventory SKU in the search box and press Enter | Refused with an "is out of stock" toast, same as the tile and the scanner | N | Not Run |
| POS-045 | A sold-out line cannot be typed down to zero | With an Inventory line whose stock hit 0 elsewhere, type a new quantity | Quantity stays at 1 and the line stays flagged; Payment stays blocked and no zero-quantity line is sent | N | Not Run |
| POS-039 | Customer can be chosen on the payment page | Open /pos/payment with no customer, pick one from the dropdown above Amount Due | Selection sticks, the header names them, and the credit panel appears for a credit sale — without going back to the cart | P | Not Run |
| POS-040 | Clearing the customer on the payment page | Pick a customer, then clear the selection | Reverts to Walk-in customer; the credit panel disappears and the credit-sale guard reappears | P | Not Run |
| PAY-036 | Non-credit customer flagged up front | Select a customer with creditAllowed false, choose Credit | "not approved for credit" shown immediately, not on submit | N | Not Run |
| PAY-037 | Unlimited customer is never blocked | creditAllowed with creditLimit null, large credit sale | No warning; sale completes | P | Not Run |
| PAY-038 | Credit unreadable does not block selling | Break /customers/{id}/credit (offline), take a credit sale | Non-blocking notice; Complete Payment still enabled; server enforces on completion | N | Not Run |
| PAY-028 | Due date required in the POS | Choose Credit/Partial at checkout, leave the due date blank | Complete Payment stays disabled and names the missing due date | N | Not Run |
| PAY-029 | Due date field hidden on a fully paid sale | Choose Cash for the full amount | No due-date field shown; none sent | P | Not Run |
| PAY-030 | Record payment from the customer page | Customer detail → Record payment, amount/method/reference | New row in the Credit history table with its date and time; the account figures update in place | P | Not Run |
| PAY-041 | No Record payment on the sale detail | Open a credit sale | No Record payment button — credit is settled on the customer's account | P | Not Run |
| PAY-039 | Payment history is a full-width table under the items | Open a credit sale that has instalments | "Payments received" table sits below the item table with Date & time / Method / Reference / Amount, one row per instalment, and a Total received row once there is more than one | P | Not Run |
| PAY-040 | Payment history states an unpaid credit sale | Open a credit sale with nothing received | Table shows "Nothing received yet — this sale is entirely on credit." | P | Not Run |
| PAY-031 | Payment method printed on the bill | Open the A4 bill for a card sale, then for a credit sale | "Method: Card"; a sale taken on credit reads "Credit"; a part payment reads "Cash, Credit"; the due date is printed | P | Not Run |
| PAY-032 | Bill updates to the real method once settled | Record a bank transfer settling a credit sale, reprint the A4 bill | Method now reads "Bank transfer" — Credit is gone | P | Not Run |
| PAY-033 | Thermal receipt states credit too | Print the thermal receipt for a part-paid credit sale | Payment lines read "Cash <paid>" and "Credit <balance>", labelled not raw codes | P | Not Run |

## DISC — Discount basis

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| DISC-010 | Whole-line fixed discount | 3 × Rs. 1,000, Rs. 100 off the line | Rs. 100 off; line Rs. 2,900 | P | Automated |
| DISC-011 | Per-unit fixed discount | Same with basis UNIT | Rs. 300 off; line Rs. 2,700; basis stored | P | Automated |
| DISC-012 | Omitted basis stays whole-line | Complete with no discountBasis | Treated as LINE — every pre-existing sale keeps its meaning | P | Automated |
| DISC-013 | Per-unit percentage refused | PERCENTAGE with basis UNIT | 400 "must be a fixed amount" | N | Automated |
| DISC-014 | Per-unit cannot drive a line negative | Rs. 5,000/unit off a Rs. 1,000 item | Line floors at 0; never negative | N | Automated |
| DISC-015 | Order discount unaffected | Per-unit line discount plus a fixed cart discount | Cart discount taken once, not multiplied | P | Automated |
| DISC-017 | Quotation honours a per-unit line discount | Quote 3 × Rs. 1,000 with Rs. 100 off each unit | Rs. 300 off; line Rs. 2,700; basis stored on the revision | P | Automated |
| DISC-018 | Conversion charges what was quoted | Convert a per-unit quotation to a sale | Sale total equals the quoted grand total; the sale line keeps basis UNIT | P | Automated |
| DISC-019 | Per-unit percentage refused on a quotation | PERCENTAGE with basis UNIT | 400 | N | Automated |
| DISC-020 | Basis survives a revision | Revise a per-unit quotation without touching its lines | The revision keeps per-unit and the same grand total | P | Not Run |
| DISC-021 | Cart and bill say which kind | Apply each kind in the POS, print the bill | Cart chip reads "off each unit" / "off the line"; the bill shows "(Rs. 100.00 × 3)" only for per-unit | P | Not Run |
| DISC-023 | Printed A4 invoice says which kind | Print the A4 bill (/print/sales/{id}) for a per-unit discounted sale | Discount cell reads "- Rs. 300.00 (Rs. 100.00 × 3)"; a whole-line discount reads just the amount | P | Not Run |
| DISC-024 | Thermal receipt says which kind | Print the thermal receipt for the same sale | Discount cell reads "-Rs. 300.00 (Rs. 100.00/u)" | P | Not Run |
| DISC-022 | Quotation document says which kind | Print a quotation with a per-unit line | Discount cell shows "- Rs. 300.00 (Rs. 100.00 × 3)" | P | Not Run |
| DISC-016 | Approval cannot be re-scoped | Approve Rs. 100 off the line, then submit it as per-unit | Refused — the token is bound to the basis | N | Not Run |

## MARK — Accounting for a credit invoice

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| MARK-001 | Ticking records who and when | Customer page → Invoices → Mark paid on one of two credit invoices | Row shows the timestamp and the user's name | P | Automated |
| MARK-002 | Ticking moves no money | Same, then re-read the account | Outstanding, the sale's balance and its payment status are all unchanged | P | Automated |
| MARK-003 | Last uncovered invoice is blocked | Tick the first of two, then try the second | 400 naming the last invoice; the button is disabled with the reason on hover | N | Automated |
| MARK-004 | A lone credit invoice cannot be ticked | Customer with exactly one credit invoice | Refused — it is both first and last | N | Automated |
| MARK-005 | Paying settles what was left | Clear the account after ticking one of two | Both invoices are settled; no second tick needed | P | Automated |
| MARK-015 | Clearing accounts for every invoice left | Two credit invoices, neither ticked, then clear the account | Both show Accounted for, stamped with the settlement time and the person who took the payment | P | Automated |
| MARK-016 | An earlier tick keeps its owner | Manager ticks one, owner then clears the account | The ticked one keeps the manager's name and time; the other is stamped with the owner's | P | Automated |
| MARK-017 | A part payment accounts for nothing | Pay half the account | No invoice gains an Accounted for value | N | Automated |
| MARK-006 | A tick can be undone | Undo on a ticked invoice | markedPaidAt cleared | P | Automated |
| MARK-007 | A till-paid sale cannot be ticked | Mark a fully paid cash sale | 400 — nothing to account for | N | Automated |
| MARK-008 | The list is scoped to the customer | Two customers with credit invoices | Each page shows only its own | P | Automated |
| MARK-010 | Blocked button explains itself on hover | Hover the disabled Mark paid on the last invoice | Tooltip names the outstanding amount and why it is blocked | P | Not Run |
| MARK-011 | No undo once accounted for | Mark an invoice paid | The action column shows no button afterwards; the tick stands | P | Not Run |
| MARK-012 | Invoices table pages and searches | Customer with more than 10 invoices; search an invoice number | Pages of 10 with Previous/Next; search narrows to matching invoices | P | Not Run |
| MARK-013 | Last-invoice rule survives paging | Customer whose only unaccounted invoice is on page 2 | The rule still applies to it — the count is taken across the account, not the page | N | Not Run |
| MARK-014 | Credit history pages and searches | Customer with more than 10 payments; search a method or reference | Pages of 10; search matches date, method, reference and amount | P | Not Run |
| MARK-018 | A ticked invoice reads Paid on the sales page | Tick one of two invoices, open the sales list | The badge reads Paid there too; the Credit filter excludes it and the Paid filter includes it | P | Automated |
| MARK-019 | A ticked invoice is no longer overdue | Tick an overdue invoice, apply an overdue query | It is not returned | P | Automated |
| MARK-020 | Sale detail shows who ticked it | Open the sale after ticking | Badge reads Paid; markedPaidBy carries the user | P | Automated |
| MARK-009 | Invoices table matches the sales page | Compare a customer's rows with /sales filtered to them | Same sales, same totals, same payment badges | P | Not Run |

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
| SALE-012 | Sale with no date is dated now | Complete a sale without `saleDate` | `completedAt` is the current time | P | Not Run |
| SALE-013 | Past date stored as the sale date | Complete with `saleDate` 10 days ago | `completedAt` falls on the picked day | P | Not Run |
| SALE-014 | Future sale date rejected | Complete with `saleDate` = tomorrow | 400; no sale created | N | Not Run |
| SALE-015 | Rejected date moves no stock | Complete with a future `saleDate` | Stock unchanged; no sale row, no sync job | N | Not Run |
| SALE-016 | Stock moves today for a backdated sale | Complete dated 45 days ago | Stock decremented now, not on the picked date | P | Not Run |
| SALE-017 | Backdated sale lists under its invoice date | Filter the sales history by the picked day, then by today | Present in the first, absent from the second | P | Not Run |
| SALE-018 | Backdated sale prints its invoice date | Open the A4 bill for a backdated sale | Document date is the picked date | P | Not Run |
| SALE-019 | QuickBooks filed under the invoice date | Sync a backdated sale | QBO document `TxnDate` equals the picked day | P | Not Run |
| SALE-020 | Quotation conversion is not backdated | Convert a quotation to a sale | Sale is dated now; no backdating on this path | P | Not Run |
| SALE-021 | Overdue filter returns only sales past due and owing | `GET /sales?overdue=true` with one overdue and one not-yet-due credit sale | Overdue one present, the other absent; every row still owes money | P | Automated |
| SALE-022 | Settling drops a sale from the overdue filter | Record a full payment on an overdue sale, re-query | No longer returned | P | Automated |
| SALE-023 | Sales list reports the last payment received | Part-pay a credit sale, read the list row | `lastPaymentAt` set; `paymentDueDate` returned | P | Automated |
| SALE-024 | Due column blank for a fully paid sale | Cash sale in the sales list | Due column shows "—", not an invented date | P | Not Run |
| SALE-028 | Credit filter excludes account-settled sales | Filter by Credit with one owing and one account-settled sale | Only the owing one is returned | P | Automated |
| SALE-032 | Paid filter includes account-settled sales | Filter by Paid after clearing an account | The covered sales are returned | P | Automated |
| SALE-033 | Settled sales report when their account cleared them | Read a covered sale from the list | creditSettledAt is set | P | Automated |
| SALE-029 | PARTIAL still narrows via the API | GET /sales?paymentStatus=PARTIAL | Only the part-paid sale — the enum still discriminates for API callers | P | Automated |
| SALE-031 | Sales list has no Items column | Open the sales list | Columns are Sale, Date, Customer, Cashier, Total, Due, Payment, Last payment, Sync, Actions — no item count | P | Not Run |
| SALE-030 | Credit reads as "Credit" everywhere | A sale on credit; check the sales list, the sale detail badge and the dashboard recent sales | All read "Credit" — no "Partially paid", no "Credit / Unpaid" | P | Not Run |
| SALE-027 | Total is red while a sale is owed for | Sales list with one credit and one cash sale | Credit sale's Total is red; the paid one is not; there is no Balance column | P | Not Run |
| SALE-025 | Last payment blank for a counter sale | Cash sale in the sales list | Last payment column shows "—" (the sale never ran on credit) | P | Not Run |
| SALE-026 | Overdue export matches an overdue query | Request the report with overdue=true | Export covers exactly those sales and names the filter. NOTE: the sales page no longer offers an Overdue control; the API filter remains for reports and callers | P | Not Run |

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

## EXC — Exchanges

> **Status: the Exchange transaction exists (D128, Phase 7). D2's "not implemented" caveat is lifted (D128b).**
>
> An `Exchange` row links a **return leg** (`returnId`, required) and a **replacement
> sale leg** (`replacementSaleId`, nullable) against an `originalSaleId`, numbered
> `X-000001` from `DocumentSequence`. `POST /v1/exchanges` (module `EXCHANGES`,
> permissions `return:create` **and** `sale:create`) runs the return through
> `ReturnsService`, then drafts and completes the replacement through `SalesService`;
> it computes no prices, moves no stock and writes no payment of its own — the two
> legs do. Settlement is **gross** (D128a): the return refunds by `refundMethod`
> (default CASH) and `payments` must cover the replacement in full, so an even swap
> nets to zero at the drawer. The legs are not one transaction: if the replacement
> fails the exchange stays open with `replacementSaleId` null and the customer
> already refunded (D128). Inside an exchange the `Full-sale return` approval trigger
> is waived and no other (D130). The screen is `/exchanges/new?saleId=`, reached from
> a completed sale's detail page; integration coverage is
> `apps/api/test/integration/specs/exchanges.spec.ts`.
>
> `EXC-D-*` (document) cases remain the Tile Shop A4 regression, covered by
> `apps/api/src/modules/documents/documents.preview.spec.ts` plus `SET-013` and
> `DOC-014`; since `7.3` the note carries real per-line tax instead of a hard-coded 0.
>
> Out of scope by decision: QuickBooks for retail tenants (D120 —
> `AccountingProviderKind.NONE`), so EXC-T-005 stays blocked; multi-line, cross-branch
> and cross-sale exchanges (D128b). Exchanges remain excluded from the Restaurant
> profile (`EXCHANGES` is not in `FOOD_SERVICE_MODULES`).

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| EXC-D-001 | Exchange A4 document renders | Settings → document preview → type "Exchange" | A4 note renders with returned + replacement lines and a net difference | P | Passed |
| EXC-D-002 | Returned lines are negative, replacements positive | Preview an exchange with both line kinds | Returned lines prefixed "Return:" and negated; replacements prefixed "New:" | P | Passed |
| EXC-D-003 | Exchange document honours letterhead settings | Change logo/accent/margins, re-preview | Exchange doc reflects the same document settings as invoice/quotation | P | Passed |
| EXC-D-004 | Signature blocks present on the exchange doc | Preview exchange | Same signature chain as other document types (see DOC-014) | P | Passed |
| EXC-T-001 | Create an exchange transaction | Completed sale of one Medium → sale detail → Exchange (`/exchanges/new?saleId=`) → choose the returned item, choose the Large at the same price as replacement → Complete exchange | 201 from POST /v1/exchanges with `exchangeNumber` X-000001, `returnedValue` = `replacementValue`, `netDifference` 0 and `complete` true; a Return R-… and a Sale S-… exist and are linked; the page reads "Both legs completed." with "Refunded to customer" and "Charged for replacement"; GET /v1/exchanges lists it and another tenant cannot read it by id | P | Not Run |
| EXC-T-002 | Exchange adjusts stock for returned and replacement items | Medium and Large both at 10; exchange one Medium for one Large; replay the identical request with the same `Idempotency-Key` | Medium 11 and Large 9, each moved exactly once with its own `StockMovement`; the replay returns the SAME exchange (same id and number), refunds nothing again and moves no stock; the body field `idempotencyKey` behaves like the header | P | Not Run |
| EXC-T-003 | Exchange with a net amount due collects payment | Returned Medium 1,000, replacement Large 1,500, `payments` CASH 1,500, `refundMethod` left default | The return refunds 1,000 CASH and the sale is paid 1,500 in full — gross settlement (D128a), never netted through store credit; `netDifference` 500 and the page reads "Customer paid extra"; a `payments` total short of the replacement is refused by the sale path exactly as an ordinary sale | P | Not Run |
| EXC-T-004 | Exchange with a net refund issues a refund | Returned 1,500, replacement 1,000, CASH 1,000; then repeat on a walk-in sale with `refundMethod` STORE_CREDIT | 1,500 refunded on the return leg, 1,000 charged, `netDifference` −500 and "Customer got back"; the store-credit attempt is refused "Store credit requires a saved customer…" and a cash refund can never exceed what the original sale paid — the return leg keeps every ReturnsService rule | P | Not Run |
| EXC-T-005 | Exchange pushes the correct QuickBooks document(s) | — | Premise contradicted by D120/D128: retail tenants run `AccountingProviderKind.NONE` and `ExchangesService` writes nothing accounting-side; the legs are an ordinary Return and Sale, so any QuickBooks behaviour belongs to RET-014/RET-015 and QB-*, not to an exchange case | P | Blocked — out of scope (D120/D128) |
| EXC-T-006 | Exchange requires a permission (`exchange:create`) | POST /v1/exchanges as a role holding `return:create` but not `sale:create`, then the reverse; open a completed sale as each | 403 both ways — D128 mints no `exchange:create`; the route requires BOTH `RETURN_CREATE` and `SALE_CREATE`, and the sale detail shows the Exchange button only to a user holding both ("You need permission to take returns and to make sales." otherwise) | N | Not Run |
| EXC-T-007 | Exchange is hidden for Restaurant tenants | Restaurant tenant: POST /v1/exchanges, POST /v1/exchanges/preview and /exchanges/new by URL | 403 "Feature not available" on every route (`EXCHANGES` is absent from `FOOD_SERVICE_MODULES`); no Exchange button on any restaurant screen; a retail tenant with an explicit `EXCHANGES` revocation is refused the same way | N | Not Run |
| EXC-T-008 | A size swap needs no manager PIN (D130) | Sale of ONE shirt; exchange it for another size as owner or cashier with no approval token | POST /v1/exchanges/preview reports `requiresApproval` false and the completion succeeds without a token although the whole sale is being returned | P | Not Run |
| EXC-T-009 | The waiver is scoped to exchanges (D130) | The same single-line sale: POST /v1/returns/preview, then complete a standalone full return without a token; then POST /v1/returns with an extra `withinExchange: true` field | Preview lists the reason "Full-sale return"; completion is 403 `ReturnApprovalRequired` "This return requires manager approval"; the extra field is not a DTO field and changes nothing — only `ExchangesService` can set the flag | N | Not Run |
| EXC-T-010 | Every other trigger still fires inside an exchange (D130) | Exchange where the returned item's condition is DAMAGED; then approve with a manager PIN (POST /returns/approve) and retry with the token | First refused 403 with reason "A returned item is damaged, opened, or used" and the page asks for a manager PIN; with the token the same exchange completes; outside-period, over-limit, credit-customer and refund-method triggers behave the same | N | Not Run |
| EXC-T-011 | A failed replacement leaves a recoverable exchange (D128) | Complete with a `replacementItems` variant id that is not this tenant's | The request fails, but the exchange row exists with `replacementSaleId` null, `complete` false, `replacementValue` and `netDifference` null; the return has already refunded the customer; the returned size is back on the shelf and the replacement never moved; the page reads "The replacement did not complete." and the operator can ring the replacement up as an ordinary sale | N | Not Run |
| EXC-T-012 | The exchange note ties to the money that moved (D128) | Print the A4 note for an upgrade exchange (1,000 → 1,500) and for a downgrade | Note carries the X-number, "Return:" rows negated and "New:" rows positive with a real per-line tax figure on both sides, and "Balance due from customer" 500.00 read from `Return.refundTotal` and `Sale.total`, not summed from display rows; the downgrade reads "Refund to customer"; an exchange with no replacement still renders | P | Not Run |

## QUO — Quotations

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| QUO-021 | Per-unit discount toggle in the builder | New quotation, set a line discount to Rs. | An "Off the line" / "Off each unit" pair appears; the line total and its hint follow the choice | P | Not Run |
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
| CUST-013 | Sync single customer to QuickBooks | Profile → Sync to QuickBooks | Customer pushed to QuickBooks and the returned id stored | P | Not Run |
| CUST-014 | Walk-in behavior preserved | Sale without customer, then store-credit return | Return blocked per RET-009 | P | Not Run |
| CUST-015 | Sync to QuickBooks stores a real id | Profile → Sync to QuickBooks on a POS-created customer | `quickbooksCustomerId` populated; status SYNCED | P | Not Run |
| CUST-016 | Sync while disconnected fails clearly | Same action with QuickBooks disconnected | Error names the disconnection; no id written; status not left claiming success | N | Not Run |
| CUST-017 | Available credit = limit − outstanding | Credit customer with a limit and one unpaid sale | List row shows limit minus what is owed | P | Automated |
| CUST-018 | No limit shows nothing, not zero | Credit customer with `creditLimit` null | `availableCredit` is null; the column renders "—" | P | Automated |
| CUST-019 | Settling releases the credit again | Record a full payment on that customer's sale | Outstanding 0; available back to the full limit | P | Automated |
| CUST-020 | Filter to customers with credit outstanding | `hasOutstandingCredit=true` with one owing and one settled customer | Only the owing customer returned | P | Automated |
| CUST-022 | Credit endpoint reports the till's figures | GET /customers/{id}/credit for a customer with one unpaid sale | creditAllowed, creditLimit, outstanding and available all match the sale | P | Automated |
| CUST-023 | No limit reports null available | Same for a customer with creditLimit null | `creditLimit` and `available` are both null, not 0 | P | Automated |
| CUST-024 | Shown figure equals enforced figure | Sell exactly the available headroom, then one unit more | The exact-headroom sale completes; one more is 400 "Credit limit exceeded" | P | Automated |
| CUST-025 | Credit refusal visible before the sale | GET credit for a customer with creditAllowed false | `creditAllowed: false` — the till says so up front | P | Automated |
| CUST-028 | A part payment releases credit at once | Pay half a customer's account | Outstanding and available credit both move immediately, though no invoice is settled | P | Automated |
| CUST-029 | Credit history lists account payments | Customer page after two payments that clear the account | Both listed newest-first and marked as having cleared the balance | P | Automated |
| CUST-030 | Payments cannot be listed unfiltered | GET /payments with no saleId or customerId | 400 — never the whole tenant's payments | N | Automated |
| CUST-031 | Whole customer row opens the customer | Click anywhere in a row — a blank cell, the type, the phone | Customer detail opens | P | Not Run |
| CUST-032 | Row click respects what it lands on | Click the name link, the Edit link, and the credit info icon | Each does its own thing; no double navigation | P | Not Run |
| CUST-033 | Selecting text in a row is not a click | Drag to select a phone number, release | Nothing navigates; the text stays selected | N | Not Run |
| CUST-034 | Modifier-click opens a new tab | Ctrl/Cmd-click or middle-click a row | Customer opens in a new tab; the list stays put | P | Not Run |
| CUST-027 | Available credit explains itself on hover | Hover (or focus) the info icon beside Available credit | Tooltip reads "<used> of <limit> used · <left> left"; for a customer with no limit it reads "<used> used · no limit set" | P | Not Run |
| CUST-026 | Credit limit column shows a figure or nothing | Customers list with three rows: credit + limit, credit + no limit, credit not allowed | Column is headed "Credit limit"; only the first shows an amount, the other two are blank — the words "No limit" appear nowhere in the table | P | Not Run |
| CUST-021 | Available credit agrees with the limit guard | Attempt a credit sale for exactly the shown available credit | Sale completes — the displayed figure and the guard use the same number | P | Not Run |
| CUST-035 | Mobile numbers are validated | Enter a malformed number in the customer form and in the POS capture popup | Refused with a message naming the expected shape; a valid local number is accepted and searchable | N | Not Run |
| CUST-036 | QuickBooks columns only where QuickBooks is on | Compare the customers list and a customer page in the Tile Shop and in the restaurant | Tile Shop: Sync column, QuickBooks badges and detail fields; restaurant: none of them, and no "Not synced" | P | Not Run |

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
| QB-026 | Credit sale for a POS-created customer syncs | Add a customer at the till, make a credit sale, sync | Customer created in QuickBooks; Invoice carries its CustomerRef; no 6560 | P | Not Run |
| QB-027 | Re-sync creates no second QuickBooks customer | Retry the sync of QB-026's sale | Same customer id reused; QuickBooks customer list unchanged | P | Not Run |
| QB-028 | Existing QuickBooks customer is adopted, not duplicated | Create a POS customer whose name already exists in QuickBooks, then sell to them | Local record links to the existing QuickBooks customer | P | Not Run |
| QB-029 | Sales Receipt names its customer | Cash sale with a customer attached, then sync | Sales Receipt in QuickBooks shows the customer (previously blank) | P | Not Run |
| QB-030 | Walk-in cash sale still syncs | Cash sale with no customer | Sales Receipt created with no CustomerRef; no customer invented | P | Not Run |
| QB-031 | Name clashing with a vendor reports clearly | Customer named the same as an existing QuickBooks vendor | Sync fails with a message naming the clash, not a raw 6240 | N | Not Run |

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
| SET-017 | Shop timezone is settable | Settings → Business → change Timezone, Save | Value persists across reload (not silently discarded) | P | Not Run |
| SET-018 | Invalid timezone rejected | PUT /v1/settings with `timezone: "Not/AZone"` | 400 with a validation message | N | Not Run |
| SET-019 | Documents follow the shop timezone | Set shop tz, open an invoice from a device in another tz | Invoice date/time is the shop's, not the device's | P | Not Run |
| SET-020 | Screens follow the device timezone | Change the device timezone, reload the sales list | Times shift to the device zone; documents do not | P | Not Run |
| SET-021 | Receipt and invoice agree | Print the A4 bill and thermal receipt for one sale | Both state the same date and time | P | Not Run |
| SET-022 | Report exports agree | Export the sales report as PDF and XLSX | Both show the same date/time strings | P | Not Run |
| SET-023 | Dashboard day runs shop midnight to midnight | Complete a sale at 02:00 shop time; check "Today" | Counted for that shop day, not the previous one | P | Not Run |
| SET-024 | Dashboard series buckets by shop day | Sales either side of shop midnight | Each lands in its own shop-day column | P | Not Run |
| SET-025 | Existing businesses backfilled to Sri Lanka | Run migrations on a database predating the timezone field | Every business reads `Asia/Colombo`; one that had chosen another zone keeps it | P | Not Run |
| SET-026 | A newly provisioned business has a timezone | Provision a tenant, read its settings | `Asia/Colombo` stored, not merely defaulted | P | Not Run |
| SET-027 | Roll calibration on the Preview tab (D99) | Bills workspace: open Settings → Preview; A4 workspace: same tab | Bills: calibration fields and the test strip are offered, the strip prints the measured geometry; A4: neither appears | P | Not Run |
| SET-028 | A bill page is never wider than tall (D102) | Clear every document field and the logo, print a bill with one item | The page box is at least as tall as it is wide; nothing prints rotated | N | Not Run |
| SET-029 | Tax rate lives on Settings → Business (D122) | Settings → Business → "Tax rate (%)": enter 12.5, Save; then 250; then clear the field; then 0 | 12.5 is sent as a number in PUT /v1/settings `taxRatePercent` and the wizard helper (PROD-047) reads 12.5%; 250 and the empty field are refused "Enter a number between 0 and 100." / "Tax rate must be a number between 0 and 100." with no API call; 0 saves as a real rate; Save stays disabled until something changes; food-service tenants get the field too | P | Not Run |
| SET-030 | Barcode prefix and label geometry are workspace settings (D125) | /products/barcodes → "Barcode and label setup": In-store barcode prefix `2001`, width/height/columns/rows/margins/gaps, Symbology "EAN-13 (prints the barcode)", tick Product name, Size / colour, Price, SKU; Save; reopen; issue one barcode, then edit the prefix | "Barcode and label settings saved." and every value persists under `catalogue`; POST /v1/labels/preview lays cells out at the saved geometry with exactly the ticked lines; once a code has been issued the form warns that changing the prefix means reprinting every label; a tenant that types its own barcodes never has to set a prefix | P | Not Run |
| SET-031 | Promotions is gated on its own module key (D124) | Retail tenant: /products/promotions and GET /v1/promotions; restaurant tenant: the same; a tenant with an explicit `TenantModule` PROMOTIONS `isEnabled:false`; a hardware tenant | Retail and food service both reach the screen — PROMOTIONS is in both default sets, so no tenant needed a data migration; the revoked tenant gets 403 "Feature not available" on every /promotions route; hardware sees it only with an explicit enabling row | P | Not Run |

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
| DOC-008 | Receipt for reprint | Reprint receipt from sale detail | Server receipt printed for a COMPLETED, REFUNDED or VOIDED sale; a refusal is shown on the page (see DOC-021) — the client-HTML fallback applies only to the first print from the till | P | Not Run |
| DOC-009 | Receipt record per sale + mark printed | Complete sale; GET /receipts/sale/:id; mark printed | Receipt exists; status flips to PRINTED | P | Not Run |
| DOC-010 | Attach customer to a receipt | POST /receipts/:saleId/customer | Customer linked for the reprint | P | Not Run |
| DOC-011 | Document template preview from settings | Settings → preview / sample PDF | Sample renders with current letterhead/toggles | P | Not Run |
| DOC-012 | Four signature placeholders render | Enable signature fields, open any document | Authorized signature, Checked by, Approved by, Customer signature — in that order | P | Passed |
| DOC-013 | Signature toggle hides all four | Disable signature fields, open a document | No sign-off row at all | N | Passed |
| DOC-014 | Signature chain on every doc type | Open quotation, invoice, return, exchange | All four blocks present on each | P | Passed |
| DOC-015 | Signature row fits A4 width | Print a document with signature fields on | Four equal columns on one row, no wrap or overflow | P | Not Run |
| DOC-016 | Uploaded signature/stamp fit their column | Upload a wide signature image, print | Image scales to column width, does not overlap "Checked by" | P | Not Run |
| DOC-017 | A label sheet is a print job with no sale (D127) | POST /v1/labels/preview then /v1/labels/print with `labels:[{variantId, quantity:12}]`, `copies:2`; GET /v1/print-jobs, then `?saleId=<a sale>`; reprint a receipt | Preview returns HTML with 12 cells and an empty `skipped`; print queues a `PRODUCT_LABEL` job with `saleId` null, `copies` 2, status PENDING, that a print agent can mark printed; it is absent from the sale-scoped query; the receipt job still carries its `saleId` and behaves as before | P | Not Run |
| DOC-018 | Unprintable labels are reported, never silently dropped (D125/D127) | Print labels for a variant with a wrong-check-digit EAN-13, one with no barcode, one valid, and one from another workspace; then a sheet of only unprintable ones | `skipped` names each with a reason: "…is not a valid EAN-13 — most likely a wrong check digit. Reissue it under Barcodes before printing." / "No barcode. Generate one before printing EAN-13 labels." / "That variant does not belong to this workspace."; the valid one prints; the all-unprintable sheet is refused 400 `NO_PRINTABLE_LABELS` and no job is queued | N | Not Run |
| DOC-019 | Receipt and invoice show the tax breakdown and the promotion (D122/D123) | Print the A4 invoice and thermal receipt for a sale with an 18% line, a zero-rated line and a BOGO free tie; then for a sale where every line shares one rate | Every renderer names the line "Cotton T-Shirt (M — Navy)"; the tax breakdown lists "18%" and "0%" rows summing exactly to the recorded tax and is absent for the single-rate sale; the tie line reads "Promotion: <name>" and the summary shows "Promotions" separately from the manual discount; both documents agree | P | Not Run |
| DOC-020 | A return document refunds the tax the line paid (D122) | Return the zero-rated line, then the taxable line, of the mixed sale above; print each return document; also return a line from a sale predating per-line rates | The zero-rated refund carries no tax and the taxable one carries its full share — no proration between them; `ReturnItem.taxRatePercent` stores the reversed rate and a rate change between sale and return alters nothing; the pre-snapshot sale falls back to proportional refunding unchanged | P | Not Run |
| DOC-021 | A returned or voided sale keeps its receipt; a void says so (5.10) | Fully refund a sale, then reprint it from the sale page; set another sale to VOIDED (no void endpoint exists yet — database only) and reprint; try a held (DRAFT) basket | The refunded sale's receipt reprints unchanged; the voided one carries VOID across its head and "This sale was voided. Not valid as proof of purchase."; the draft is refused with "This sale is still on hold and has taken no payment, so it has no receipt yet." and its page offers no Reprint button — no runtime overlay | P | Not Run |
| DOC-022 | The 80mm receipt prints no SKU; the A4 column is a setting (5.10) | Print an 80mm receipt for a sale with SKU'd items; preview the A4 invoice on a NEW workspace, then toggle Settings → Documents → "Product SKU column" | No SKU line under any item on the receipt; the A4 shows no SKU column until the toggle is on; an existing workspace that stored `showSku: true` keeps its column; the sale's frozen receipt content still holds the SKU (reprint data is unchanged) | N | Not Run |

## RSV — Table Reservations & Calendar (D47)

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| RSV-001 | Book a table for a timeslot | Calendar → click empty slot → fill name/party/duration → save | Reservation created with RSV-###### number, block renders in the grid | P | Passed |
| RSV-002 | Double-booking rejected | Book a second reservation overlapping the first on the same table | 409 naming the blocking reservation number | N | Passed |
| RSV-003 | Back-to-back slots allowed | Book a slot starting exactly when the previous ends | Created — [start, end) intervals do not collide | P | Passed |
| RSV-004 | Day list by window | Open the calendar for the booking's day | All reservations intersecting the day window shown | P | Passed |
| RSV-005 | Lifecycle: seat then complete | BOOKED → Seat guests → Complete | Status transitions succeed, badge updates | P | Passed |
| RSV-006 | Illegal transition refused | Attempt SEATED on a COMPLETED reservation | 409 status-conflict error | N | Passed |
| RSV-007 | Past bookings refused | Create with a start hours in the past | 400 "cannot start in the past" | N | Passed |
| RSV-008 | Walk-up grace | Create with a start a few minutes ago | Allowed (recording a walk-up) | P | Passed |
| RSV-009 | Move a reservation | Edit → change table or time | Overlap re-checked at the new slot; move persists | P | Passed |
| RSV-010 | Module gating | Retail/hardware tenant calls a reservation route | 403 Feature not available; no Calendar nav item | N | Passed |
| RSV-011 | Past days read-only | Navigate the calendar to yesterday | History visible, click-to-book and New reservation disabled | P | Not Run |
| RSV-012 | Cancel and no-show | BOOKED → Cancel / No-show | Terminal states; slot freed for rebooking | P | Not Run |
| RSV-013 | Un-seat correction | SEATED → Un-seat | Returns to BOOKED only if the slot is still free | P | Not Run |
| RSV-014 | Customer link optional | Book with free-text name/phone only | Reservation saves without a Customer row | P | Passed |
| RSV-015 | Link existing customer | Search and pick an existing customer in the dialog | customerId linked; name/phone snapshotted | P | Not Run |
| RSV-016 | Permissions | Sign in as a role without reservation:view | Calendar nav item absent; routes 403 | N | Not Run |

## OTBL — Open Tables (D49/D50)

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| OTBL-001 | Create an open table joining two tables | Tables → New open table → name, select 2 available tables | Open table appears with auto code OPEN-n; members badge Reserved | P | Passed |
| OTBL-002 | Optional seat count | Create with and without Seats | With: "Seats N"; without: "Seats as arranged" | P | Passed |
| OTBL-003 | Reserved member refuses its own session | Try to seat a joined member table | 409 "joined into an open table — seat the open table instead" | N | Passed |
| OTBL-004 | Member cannot be joined twice | Create a second open table selecting a reserved member | 409 naming the table code | N | Passed |
| OTBL-005 | Members must be available | Select an occupied/archived table (API) | 409 naming the code; UI never offers them | N | Passed |
| OTBL-006 | Bill close auto-releases | Seat the open table, close its bill | Members return to Available; open table disappears | P | Passed |
| OTBL-007 | Manual dissolve | Dissolve a never-seated open table | Members released; arrangement archived | P | Passed |
| OTBL-008 | Dissolve refused mid-service | Dissolve while its session is live | 409 "close or settle its bill first" | N | Passed |
| OTBL-009 | No reservations on open tables | Book the open table on the Calendar (API) | 404 — transient tables have no calendar presence | N | Passed |
| OTBL-010 | Reserved member cannot be archived | Archive a joined member table (owner menu) | 409 in-service refusal | N | Passed |
| OTBL-011 | Permission gate | Role without open-table:manage | No New open table / Dissolve controls; POST 403 | N | Not Run |
| OTBL-012 | Orders + KOT flow through | Send a round from the open table's session | Kitchen ticket prints like any table | P | Not Run |
| OTBL-013 | Two parties share one table (D50) | Create 2 open tables both reserving the same four-top | Both created; table Reserved once | P | Passed |
| OTBL-014 | First bill does not free a shared table | Close party A's bill | Table stays Reserved; close response lists it as still-reserved | P | Passed |
| OTBL-015 | Last bill frees the shared table | Close party B's bill | Table returns to Available automatically | P | Passed |
| OTBL-016 | Billing reminder appears | Close a bill leaving tables held by another party | Dialog lists each table + who holds it, offers Unreserve, then Continue to bill | P | Passed |
| OTBL-017 | Manual unreserve (compaction) | Two threes on a four-top + two-top; close one, Unreserve the two-top | Two-top Available, four-top still Reserved for the remaining party | P | Passed |
| OTBL-018 | Unreserve refused when not held | Release a table no open table holds | 409 "not held by an open table" — the safety rule | N | Passed |
| OTBL-019 | Held-by indication on the floor | View a shared table's card | Shows "Held by <open tables>"; Unreserve renders only on held tables | P | Passed |
| OTBL-020 | Picker offers shared tables | Open the create dialog while a table is Reserved by an open table | Table selectable, marked "shared" | P | Passed |
| OTBL-021 | Occupied tables still refused | Try to join a table with its own live session | 409 naming the code | N | Passed |
| OTBL-022 | One joined table, several tabs (D104) | Open a joined table for one party, then a second tab on the same arrangement with its own name | Both tabs live on the arrangement; the tab name appears on the kitchen ticket, the bill and the floor | P | Not Run |
| OTBL-023 | A member table is not offered to a second open table (D105) | With M2 and M3 joined and in service, open the New open table picker | M2 and M3 are absent from the picker; AVAILABLE tables only | N | Not Run |
| OTBL-024 | A joined member is shown, not offered (D106) | Look at a member table on the floor while its arrangement is in service | It reads Reserved with no Unreserve control; releasing it out from under the party is impossible | N | Not Run |
| OTBL-025 | Food ready shows on the floor, per tab (D112/D104) | Join two tables, open two tabs, bump one tab's ticket | The arrangement's card shows "Food ready"; opening that tab's link clears it on this device while the other tab's link does not; no bell sounds (D118) | P | Not Run |

## KIT — Kitchen Board (D68 / D100 / D111–D116)

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| KIT-001 | Tickets age on the board (D100) | Leave a ticket outstanding past 10 and then 15 minutes | Timer turns amber at 10 min and red at 15 with the card border; completed tickets stop ageing | P | Not Run |
| KIT-002 | A wrong bump can be taken back (D100) | Mark a ticket done, then Reopen it | It returns to the outstanding tab; POST …/kitchen-tickets/:id/reopen needs the same permission as completing | P | Not Run |
| KIT-003 | The board rings for a ticket it has not seen (D111) | Place an order while the kitchen board is open; re-poll without new tickets | One chime on arrival, silence on re-polls; the kitchen SCREEN is the only one that sounds — the tables screen and the orders queue stay silent (D118) — whoever is looking at it, the till's read-only board included | P | Not Run |
| KIT-004 | Start preparing, then done (D113) | Tap Start on a queued ticket, then Mark done | Ticket moves QUEUED → IN_PROGRESS → COMPLETED; the orders queue's unified status follows (Preparing, then Ready); POST …/kitchen-tickets/:id/start needs the same permission as completing | P | Not Run |
| KIT-005 | Three lanes, each ticket in exactly one (D115/D116) | Read the board with queued, preparing and done tickets | To make · Preparing · Done; a cancelled order's ticket leaves the pass, and there is no Cancel on the board — cancelling belongs to the orders queue | P | Not Run |
| KIT-006 | Recall lands on To make (D100/D113) | Mark an IN_PROGRESS ticket done, then Reopen; try Reopen on a ticket that is still preparing | Reopen returns a done ticket to To make (QUEUED), never to Preparing; a preparing ticket has no Reopen and the call is a no-op; the till (KOT_VIEW only) sees neither Start nor Mark done | P | Not Run |

## BSPL — Bill Splitting by Item (D51)

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| BSPL-001 | Bill shows its line items | Open a closed tab's bill | Items card lists each line with qty × unit price and line total | P | Passed |
| BSPL-002 | Split by item creates a bill per guest | Assign lines to 2+ guests, Create bills | One split per guest, each listing its own items | P | Passed |
| BSPL-003 | Shares sum to the bill total exactly | Compare Σ split shares to the total | Equal to the cent, including non-divisible totals | P | Passed |
| BSPL-004 | A multi-unit line splits across guests | 3 × item assigned 2/1 to two guests | Each guest billed for their units only | P | Passed |
| BSPL-005 | Service charge shared pro rata | Split a bill carrying a service charge | Each share = own items + proportional charge | P | Passed |
| BSPL-006 | Partial assignment refused | Save with items unassigned | 400 naming the item and the shortfall; UI disables Create | N | Passed |
| BSPL-007 | Foreign item refused | Assign an orderItemId from another bill | 400 "not on this bill" | N | Passed |
| BSPL-008 | Payment allocates to its split | Collect for one split | That split's Paid rises; bill Paid rises; others unchanged | P | Passed |
| BSPL-009 | Overpaying a split refused | Pay more than a split's remaining | 400 naming the split balance | N | Passed |
| BSPL-010 | Re-split refused after payment | Split a bill that has a payment | 400 — reopen or refund first | N | Passed |
| BSPL-011 | Paying all splits settles the bill | Collect each split in turn | Bill reaches PAID with paid == total | P | Passed |
| BSPL-012 | Per-split printable bill | Click Print on a split | Print window shows that guest's items and amount only | P | Not Run |
| BSPL-013 | Amount-based splitting still works | Use "By amount" | Existing even/arbitrary split unchanged | P | Not Run |
| BSPL-014 | Permission gate | Role without bill:split | No split controls; POST 403 | N | Not Run |

## STK — Stock takes (D132)

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| STK-001 | A count sets the shelf figure, down or up (D132) | Open /stock-takes by URL (the rail entry was removed 2026-09-08) as Owner; pick the branch; add a Medium with books 10 counted 4, a Large with books 6 counted 8, and a line counted equal to the books; Post | 201 with `countNumber` SC-000001; Medium is now 4 and Large 8 — the drop is never refused; each varianced line writes a `StockMovement` reason ADJUSTMENT referencing the count; the matched line writes none; a count of only matched lines reads "Every line matched the books. Nothing was corrected, and nothing was written to the stock ledger." | P | Not Run |
| STK-002 | A count is immutable, numbered and idempotent (D132) | Post the same form twice with one `idempotencyKey`; post a second count; rename a counted product; sell the counted Medium down to 0 and try to sell one more | One StockTake and one correction; numbers run SC-000001, SC-000002 per tenant; `productNameSnapshot` still shows the old name under Previous counts; there is no edit or delete — a recount is a new count; the sale path still refuses the oversell, so the count never touched the guard | P | Not Run |
| STK-003 | A variance is valued at today's cost or not at all (D131/D132) | Count a variant that has been received (`averageCost` set) short by 2, and a variant nothing has been received against short by 1 | The first line has `unitCost` and `varianceValue` = −2 × cost; the second has both null and is counted in `unvaluedLines`; the document `varianceValue` excludes it rather than valuing it at zero; a variant never reads its parent product's cost | P | Not Run |
| STK-004 | Count refusals (D132) | POST /v1/stock-takes as a Cashier; as Owner with `lines: []`; a negative `countedQuantity`; the same product and variant twice; a branch of another tenant; then on a QuickBooks-inventory tenant | Cashier gets 403 (needs `product:manage`) but may still GET the history; 400 for the empty list and the negative count; 400 "The same product and variant appears twice in this count"; 400 "Branch … does not belong to this tenant"; the QuickBooks tenant gets 400 "Stock counts are not available for this tenant: stock is not held locally…" and nothing is written | N | Not Run |

## RPT — Retail reports (D129/D131)

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| RPT-001 | Margin is costed at today's average and says so (D131) | Sell a variant at 1,000 whose `averageCost` is 600; Reports → Margin (GET /v1/sales/reports/margin); receive more of it at a new cost; reload | Row: revenue 1000.00, cost 600.00, margin 400.00, 40.00%, `costSource` VARIANT_AVERAGE; after the receipt the same sale reads against the new average; the screen states "Cost is the weighted average as it stands today, not the cost on the day of the sale."; rows sort thinnest margin first and a loss shows as a loss | P | Not Run |
| RPT-002 | An unknown cost is unknown, never a 100% margin (D131) | Sell a variant nothing has ever been received against; open Margin | The row shows "—" for cost, margin and percent with `costSource` UNKNOWN and sorts last; totals exclude it and the note "… no recorded cost … not included in the totals above" names the revenue left out; a variant-less line falls to PRODUCT_AVERAGE or LATEST_PURCHASE, a variant never to its parent | N | Not Run |
| RPT-003 | Tax by rate ties to what was charged (D122) | Sales with 18% and zero-rated lines and an order discount; Reports → Tax by rate; include a sale predating per-line rates | Rows "18%" and "0%" whose `tax` sums exactly to the tax the sales recorded, taxable base net of the order discount; the pre-snapshot sale appears as an unattributed row and `hasUnattributed` is said on screen rather than guessed at; total tax agrees with Sales by variant | P | Not Run |
| RPT-004 | Retail reports are money-exact and gated (D129) | Compare Sales by variant totals with the payment ledger for the period; call each /v1/sales/reports/* as a Cashier; send `to` earlier than `from` | Every money figure is a 2dp string that ties to the cent — no float drift; the cashier gets 403 (`report:read`, module REPORTING); the reversed range is refused 400, never swapped | P | Not Run |

## ADM — Administration & Multi-Tenancy

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| ADM-001 | Provision fresh tenant | Run provision script with name/slug/users | Tenant + Main Branch + Register 1 + users created; credentials printed | P | Not Run |
| ADM-002 | Provisioned tenant starts empty | Log in as new owner | 0 products/customers/suppliers/sales everywhere | P | Not Run |
| ADM-003 | Provision refuses existing slug/name | Re-run same command | Aborts with clear message; nothing modified | N | Not Run |
| ADM-004 | Provision refuses duplicate email | Use an email that exists in another tenant | Aborts | N | Not Run |
| ADM-005 | Provision validates role and PIN format | Role the business type's template does not offer / 3-digit PIN / duplicate PINs | Each aborts with a specific message naming the offered roles | N | Not Run |
| ADM-006 | Provisioned PINs work for approvals | New tenant owner PIN at discount prompt | Approves within that tenant only | P | Not Run |
| ADM-007 | Tenant data isolation — API | Tenant A token requests tenant B resource ids | 404/empty; never cross-tenant data | N | Not Run |
| ADM-008 | PINs are tenant-scoped | Demo manager PIN in new tenant's approval dialog | 401 Invalid manager PIN | N | Not Run |
| ADM-009 | Document numbering per tenant | Sales in two tenants | Each has its own S-000001 sequence | P | Not Run |
| ADM-010 | Create user via API | Owner POSTs /v1/users | User created in own tenant; can log in | P | Not Run |
| ADM-011 | QuickBooks connections per tenant | Connect tenant A only | Tenant B remains Not connected | P | Not Run |
| ADM-012 | Duplicate email on user create rejected | POST /users with an existing email | 4xx conflict/validation error | N | Not Run |
| ADM-013 | Invalid role on user create rejected | POST /users with role "SUPERADMIN" | 400 | N | Not Run |
| ADM-014 | Audit log records sensitive actions | Approve a discount / change settings; GET /audit-logs | Entries with actor, action, timestamp | P | Not Run |
| ADM-015 | Salesperson is a hardware-template role (D108) | Provision `--business-type RESTAURANT` with a `SALESPERSON` user; then a HARDWARE (or no-profile) tenant with one | Restaurant provisioning aborts naming OWNER, WAITER, RESTAURANT_CASHIER, KITCHEN_STAFF and creates nothing; the hardware user is created linked to the `SALESPERSON` row with enum SALESPERSON | N | Not Run |

## UI — Theme, Layout & Responsiveness

| ID | Test Case | Steps | Expected Result | Type | Status |
|---|---|---|---|---|---|
| UI-021 | Pagination is numbered everywhere | Open sales, products, customers, quotations, returns, suppliers, the POS grid and both customer-page tables | Every footer shows numbered pages with the current one highlighted — no bare Previous/Next anywhere | P | Not Run |
| UI-022 | Page numbers collapse on long lists | A list of 40+ pages | Shows 1 … current-1 current current+1 … last; the first and last stay reachable and the row keeps its width | P | Not Run |
| UI-023 | Rows per page only where it applies | Compare a list page with the quotations and suppliers lists | Rows-per-page appears where the size is adjustable and is absent where it is fixed; the range still shows | P | Not Run |
| UI-017 | Tooltips are not clipped by their table | Hover a tooltip in the sales, products, customers or invoices table | The bubble shows in full above the row, not trimmed to the cell or the card | P | Not Run |
| UI-018 | Tooltip follows the page as it scrolls | Hover a tooltip, then scroll the table or the page | It stays with its trigger, or goes away — never stranded mid-screen | P | Not Run |
| UI-019 | Tooltip on a disabled control | Hover the disabled Mark paid on a customer's last invoice | Reason is shown; the button is still not clickable | P | Not Run |
| UI-020 | Tooltip near a viewport edge | Hover a tooltip on the first row and on the rightmost column | Flips below at the top; never runs off the side | P | Not Run |
| UI-001 | Dark mode toggles instantly | Toggle theme | All surfaces/tokens switch (not just scrollbar) | P | Not Run |
| UI-002 | Theme persists across reload | Set dark, reload | No flash of wrong theme (pre-paint script) | P | Not Run |
| UI-003 | System theme mode follows OS | Mode=system, flip OS preference | UI follows live | P | Not Run |
| UI-004 | Sidebar collapse persists | Collapse, reload | Stays collapsed; icons+tooltips shown | P | Not Run |
| UI-005 | Mobile nav drawer | <768px, tap header menu button | Drawer opens; closes on route change and Escape | P | Not Run |
| UI-006 | Header minimal on desktop | ≥768px | No hamburger, no branch/register chips; the account menu shows the person's name and role only (D109) | P | Not Run |
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
| UI-024 | The food-service rail names the catalogue "Menu" (D103) | Restaurant owner rail vs Tile Shop rail | Restaurant: Menu with the book icon, href /products, no Inventory; Tile Shop: Products | P | Not Run |
| UI-025 | The account menu names the role row, not the enum | Sign in as the seeded waiter | Button and menu read "Waiter", never "Cashier"; a session minted before roleName shows the enum spelt for a person | P | Not Run |
| UI-026 | Sound lives in the kitchen alone (D118) | Sign in as waiter, cashier and kitchen staff; place and bump an order | Only the kitchen board plays a chime; the tables screen and the orders queue are visual only | P | Not Run |

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
| AUTH | 15 | CUST | 36 |
| PERM | 16 | CIMP | 10 |
| DASH | 24 | SUP | 15 |
| PROD | 50 | SIMP | 8 |
| PIMP | 13 | QB | 31 |
| POS | 62 | SET | 31 |
| PAY | 41 | DOC | 22 |
| DISC | 15 | RSV | 16 |
| MARK | 20 | OTBL | 25 |
| SALE | 33 | BSPL | 14 |
| RET | 18 | KIT | 6 |
| EXC-T | 12 | ADM | 15 |
| EXC-D | 4 | UI | 26 |
| QUO | 21 | SEC | 12 |
| STK | 4 | RPT | 4 |

**Total: 619 test cases** (counted from the tables above; the restaurant modules — EXC, RSV, OTBL, BSPL, KIT — and the retail modules — STK, RPT — are included, and the EXC-T rows now count as coverage since D128 made the transaction real).

### Notes for automation

- IDs are stable — name Playwright specs after them (e.g. `pos.spec.ts` →
  `test('POS-005 typed quantity clamps to stock', …)`).
- Seed-dependent cases (AUTH-007, ADM-*) need the dev seed or the provisioning
  script as fixtures; QB-* cases need a QuickBooks sandbox connection and are
  best tagged `@quickbooks` so they can be excluded from CI without secrets.
- Concurrency cases (PAY-014, PAY-015) are API-level tests, not browser tests.
- Credit-management cases are automated API-level in
  `apps/e2e/tests/credit-management.spec.ts` (28 cases); the remaining ones in those groups
  are browser cases still to be scripted. Credit is settled per CUSTOMER ACCOUNT, so any new
  case must exercise `POST /payments {customerId}` — there is no per-invoice settlement.
