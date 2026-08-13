# Restaurant POS — hardcoded data & missing APIs

Audit of the Restaurant POS surface for values that are hardcoded but should be
tenant/branch configuration, and for the APIs missing to make that possible.

**Scope audited:** 116 files — 65 API module files across `restaurant`,
`dining`, `table-sessions`, `kitchen`, `takeaway`, `billing`, `reservations`,
`restaurant-reports`, `restaurant-orders`, `menu`, `delivery-hub`; 51 web
components across `components/restaurant/**` and `components/pos/**`, plus the
restaurant routes and `lib/restaurant/**`.

**Headline:** the restaurant POS cannot currently bill correctly. Tax is
hardcoded to zero, discounts and promotions never reach a bill, and every sale
is attributed to an arbitrary register and an arbitrary user. Two separate
paths let a guest be charged for food the kitchen is never told to cook.

**Status legend:** `OPEN` · `FIXED` · `DEFERRED` (with a reason) · `WONTFIX`

---

## A. Money is wrong — BLOCKERS

| # | Finding | Where | Consequence | Status |
|---|---|---|---|---|
| A1 | `taxAmount: new Prisma.Decimal(0)` hardcoded on every restaurant close | `table-sessions.service.ts:744` | Retail applies `settings.taxRatePercent` (`sales.service.ts:410`); restaurant never does. Verified on live data: every restaurant sale has tax `0.00`. A VAT-registered restaurant issues legally wrong bills. | **FIXED (D52)** |
| A2 | Client mirrors it: `const [taxPct, setTaxPct] = useState(0)` | `pos-counter-workspace.tsx:126` | Comment admits tenant settings are never fetched. Cashier quotes a total the server disagrees with. | OPEN |
| A3 | `totalDiscount: 0` hardcoded; **no discount path exists at all** for a restaurant bill | `table-sessions.service.ts:743` | No endpoint can discount a restaurant bill. Staff will void items as a workaround. | OPEN |
| A4 | Promotions are surfaced by the POS catalogue but never applied at close | `pos-catalogue.service.ts:150-165` vs close path | The guest sees a happy-hour badge, then pays full menu price. | OPEN |
| A5 | `packagingCharge: 0` hardcoded | `table-sessions.service.ts:746` | Column and a UI row exist; nothing ever sets it. Schema comment already names the missing config. | **FIXED (D52)** |
| A6 | Takeaway sets `total: subtotal` — no service charge, no tax | `takeaway.service.ts:237-239` | The same branch charges service on dine-in and silently drops it on takeaway. | **FIXED (D52)** |
| A7 | Takeaway ignores `MenuItemChannelPrice` and drops modifiers (`modifierTotal: 0`) | `takeaway.service.ts:135-136` | Configured takeaway pricing never charged; paid add-ons given away free and absent from the KOT. | OPEN |
| A8 | Reports coerce `Decimal` → float, then `.toFixed(2)` | `restaurant-reports.service.ts:81-84`, `129-137`, `182`, `205-210` | Report totals will not tie out to the payment ledger. | OPEN |
| A9 | Modifier totals summed as floats then converted back to `Decimal` | `table-sessions.service.ts:505-508`, `567` | Contradicts the file's own comment 180 lines below. Cent drift on fractional modifier prices. | **FIXED (D52)** |

## B. Attribution is invented — BLOCKERS

| # | Finding | Where | Consequence | Status |
|---|---|---|---|---|
| B1 | Register chosen by `findFirstOrThrow` with **no `orderBy`** | `table-sessions.service.ts:715-719` | Multi-register branches: every dine-in sale lands on an arbitrary till; X/Z reports and drawer reconciliation are wrong for both. Not even stable between two closes. | **FIXED (D52)** |
| B2 | Cashier falls back to "first active user in tenant"; **not branch-scoped** | `table-sessions.service.ts:721-732` | Sales book against whoever the query returns (typically the owner). Branch B's bill can be attributed to a branch A user. | **FIXED (D52)** |
| B3 | Takeaway repeats both heuristics | `takeaway.service.ts:223-229` | Same consequences on the takeaway path. | **FIXED (D52)** |
| B4 | Sale stamped `COMPLETED` + `completedAt` before any money is taken | `table-sessions.service.ts:748-752` | Revenue reports filtering `status: COMPLETED` count unpaid and walked-out bills as banked revenue. `TableSessionStatus.BILLING` exists and is never used. | **DEFERRED (D52)** — financial-state redesign; changes what every report, returns and QB sync can see |

**Note on B2:** needs no new API. `closeSession` is the only method in its class
that does not take `actorUserId`, and the controller already holds `actor.id`.

## C. Food ordered but never cooked — BLOCKERS

| # | Finding | Where | Consequence | Status |
|---|---|---|---|---|
| C1 | Unrouted items routed to `'__unrouted__'` then `continue`d | `kitchen.service.ts:146-148` | Despite a comment claiming it "doesn't silently disappear", it does: no ticket, no warning. A dish nobody routed is billed and never made. | OPEN |
| C2 | Accepting a delivery order creates a `RestaurantOrder` with **zero items** and never calls `generateTicketsForRound` | `delivery-hub.service.ts:121-208` | Verified directly: injected `KitchenService` is unused. No KOT prints; Sale subtotal is `0.00` while the platform collected the real total. | OPEN |
| C3 | "Reprint" casts through `unknown` to reach a private Prisma instance and flips a status | `kitchen-tickets.controller.ts:85-89` | Audit entry and status change, but **no paper**. Kitchen believes a reprint was requested. | OPEN |
| C4 | Station with no printer → `primaryPrinterId: null`, zero print attempts | `kitchen.service.ts:158-163` | Tickets sit `QUEUED` forever with no failure recorded. | OPEN |
| C5 | Mark-printed flips status unconditionally, and `where` omits `tenantId` | `kitchen.service.ts:254-258` | A failed print is recorded as successful; cross-tenant ticket mutation possible. | OPEN |
| C6 | No retry policy exists; no ticket ever reaches `FAILED` | `kitchen.service.ts:267-272` | A printer offline mid-service leaves tickets queued forever with no alert. | OPEN |

## D. Dead config — exists but unreachable or unread

| # | Finding | Where | Status |
|---|---|---|---|
| D1 | Settings UI has 4 tabs (`Business, Branding, Layout, Preview`) and its save handler sends **only `{ documents }`** | `settings/page.tsx:32`, `:85` | OPEN |
| D2 | `RestaurantBranchConfig` has 4 business fields; `restaurantConfig.update()` exists in the web client with **zero callers** | `lib/restaurant/api.ts:71-86` | OPEN |
| D3 | `defaultTicketTargetMinutes` stored, validated, audited, returned — **read by nothing** | schema `:1486` | OPEN |
| D4 | `KitchenStationPrinter` is read but **never written**; no API links a station to a printer | `kitchen.service.ts:158` | OPEN |
| D5 | `AppSettings.currency` exists; `formatMoney(v, currency = 'LKR')` hardcodes the default across the restaurant surface | `labels.ts:188` | OPEN |
| D6 | `utils.ts` `formatMoney(amount, _currency?)` **discards** its currency argument — while `pos/payment/page.tsx:69` genuinely passes it | `utils.ts:16` | OPEN |
| D7 | `KitchenStation` / `KitchenPrinter` have full CRUD APIs and **no UI at all** | — | OPEN |
| D8 | Branch-scoped `TenantSettings` rows are schema-legal; settings service only ever reads/writes `branchId: null` | `settings.service.ts:154`, `194`, `201` | OPEN |
| D9 | Orders "Filters" panel says "stubbed for the pilot" while `OrdersQuery` already supports `paymentStatus`/`from`/`to`/`limit` | `orders-page.tsx:341` vs `api.ts:876-884` | OPEN |

**Consequence of D1:** a tenant cannot set their own tax rate or currency
anywhere in the app, even though the API accepts both.

## E. Config that does not exist — the missing-API list

| # | Missing concept | Currently hardcoded at | Status |
|---|---|---|---|
| E1 | **Service / opening hours** (zero hits repo-wide) | `reservation-calendar.tsx:42-43` (08:00–23:00). Reservations accept a 04:00 booking at a closed restaurant. | OPEN |
| E2 | **Table turnaround buffer** | `reservations.service.ts:241-252` — exact-adjacent overlap check; a 15-min reset means guaranteed double-seating | OPEN |
| E3 | **Reservation defaults** (duration, time, party size) | `reservation-calendar.tsx:499` (`90`), `:496` (`'19:00'`), `:490` (`'2'`); server bounds 15–720 with no branch default | OPEN |
| E4 | **Past-booking grace** | `reservations.service.ts:64` — `PAST_GRACE_MS = 15 * 60 * 1000`, platform-wide | OPEN |
| E5 | **Capacity enforcement** | `partySize`/`guestCount` never compared to `RestaurantTable.capacity`. Book 12 onto a two-top. | OPEN |
| E6 | **Reservation ↔ session link** | Seating never flips a booking to `SEATED`; `BILLING` sessions do not block re-seating (`table-sessions.service.ts:151-155`) | OPEN |
| E7 | **Cleaning state** | `CLEANING`/`BILLING` enum values exist and are set by **no code**; a table is bookable the instant the bill closes | OPEN |
| E8 | **Enabled payment methods** | Four divergent hardcoded lists: `bill-screen.tsx:23`, `pos/payment/page.tsx:41`, `payment-method-selector.tsx:34`, `payment-popup.tsx:81`; plus a DTO `@IsIn` duplicating the enum (`billing.dto.ts:17`) | OPEN |
| E9 | **Delivery partners** | `orders-page.tsx:274-279` — hardcoded list including a **`Mock (dev)`** chip shown to production users; no partner CRUD endpoint | OPEN |
| E10 | **Timezone / business-day** | Reports use `toISOString()` (UTC). At UTC+5:30 after 18:30, "Today" reports *tomorrow* (`restaurant-reports.tsx:41-42`, controller default 30-day window) | OPEN |
| E11 | **Printer hardware profile** | No paper width or chars-per-line on `KitchenPrinter`; a 58mm printer garbles an 80mm layout (`kitchen.dto.ts:18`) | OPEN |
| E12 | **Numbering formats** | `TS-`, `RO-`, `RSV-`, `S-`, `KOT-`, `OPEN-` prefixes and 6-digit width hardcoded, while quotations already have configurable `numberFormat` | OPEN |
| E13 | **Kitchen station categories** | DTO `@IsIn(['KITCHEN','BAR','GRILL','COLD','DESSERT'])` **contradicts the schema comment** saying the column is a string precisely so tenants can add their own | OPEN |
| E14 | **Dietary tags** | `types.ts:143` freezes 5 tags under a comment claiming runtime extension. Nut-free/dairy-free are legal labelling requirements in several markets. | OPEN |
| E15 | **Poll intervals** | `kitchen-board.tsx:96` (5s, duplicated as UI copy at `:171`), `orders-page.tsx:110` (8s, duplicated at `:157`), `order-entry.tsx:165` (8s) | OPEN |
| E16 | **Defaults**: table capacity `'4'`, party size `2`, prep-time ceiling 360, discount reasons, cash denominations | `table-floor.tsx:824`, `:665`, `wizard-state.ts:143`, `item-discount-dialog.tsx:30`, `payment-popup.tsx:442` | OPEN |
| E17 | **Per-channel service charge** | `pos-counter-workspace.tsx:205` hardcodes "third-party never carries service charge" as client policy | OPEN |
| E18 | **`UnifiedOrderView.sessionId`** | `order-detail-drawer.tsx:299` — `deriveSessionId()` returns `''` unconditionally; the dine-in deep link is dead | OPEN |
| E19 | **POS picker categories** | `use-menu-data.ts:123` builds 4 synthetic sections and discards the `category`/`subcategory` the catalogue already returns | OPEN |

## F. Branding leaking onto customer documents

| # | Finding | Where | Status |
|---|---|---|---|
| F1 | **My own D51 split bill prints amounts with no currency at all**, and computes balance client-side with `.toFixed(2)` | `receipt-print.ts:145`, `:132` | OPEN |
| F2 | `storeName: 'Hardware POS'` hardcoded on the thermal receipt | `pos/payment/page.tsx:236` | OPEN |
| F3 | `profile.companyName \|\| 'Hardware POS'` on the A4 invoice — an *empty* company name silently becomes the vendor brand | `document-template-service.ts:110` | OPEN |
| F4 | Same fallback on the offline receipt, which fires exactly when the server is down | `receipt-print.ts:39` | OPEN |
| F5 | `storeName: session.branchName ?? 'Axlo POS'` — branch name used as business name on the split bill | `bill-screen.tsx:243` | OPEN |
| F6 | `branchName="Main Dining"` / `registerName="Counter 1"` hardcoded in **all three** POS workspaces | `pos-dine-in-workspace.tsx:223-224`, `pos-takeaway-workspace.tsx:316-317`, `pos-third-party-workspace.tsx:58-59` | OPEN |

## G. Simulated / stub integrations

| # | Finding | Where | Status |
|---|---|---|---|
| G1 | Only a **MOCK** delivery adapter ships; other platforms throw `NotImplementedException` at webhook time | `delivery-platform-registry.ts:23-29` | OPEN |
| G2 | The webhook **discards the signature header** (`_signature`) | `delivery-webhook.controller.ts:34` | OPEN |
| G3 | `KOT sent to Kitchen` confirmation hardcoded `on={true}` — green even when the printer failed | `order-completion-screen.tsx:76` | OPEN |
| G4 | Developer text rendered as production UI: *"Backend gap: no `deliveryAddress` column on TakeawayOrderProfile yet."* Address stuffed into `notes` with a `[Delivery]` prefix. | `customer-capture-popup.tsx:252` | OPEN |
| G5 | Adapter call `await`ed **inside** a Prisma transaction with no timeout/outbox | `delivery-hub.service.ts:203-204` | OPEN |
| G6 | Per-product availability window not applied to the POS catalogue | `pos-catalogue.service.ts:98-99` (TODO) | OPEN |

## H. Permissions and correctness gaps found alongside

| # | Finding | Where | Status |
|---|---|---|---|
| H1 | Floor-plan and config reads gated on the generic `PLATFORM_PROFILE_READ` instead of the `TABLE_VIEW` that already exists | `dining-areas.controller.ts:34`, `restaurant-tables.controller.ts:140`, `open-tables.controller.ts:29`, `restaurant-config.controller.ts:29` | OPEN |
| H2 | Orders filter parsers silently fall back to `'ALL'` on an unrecognised value instead of 400 | `restaurant-orders.controller.ts:57-75` | OPEN |
| H3 | Orders list applies `take` per channel *before* merge/filter/re-slice — orders vanish with no indication | `restaurant-orders.service.ts:90`, `112`, `200`, `254` | OPEN |
| H4 | Order provenance invented from which optional contact fields are filled | `restaurant-orders.service.ts:157-163` | OPEN |
| H5 | Missing tenant scoping on several queries | `restaurant-reports.service.ts:73`, `:174`; `restaurant-orders.service.ts:142`; `kitchen.service.ts:109`, `:115`, `:158` | OPEN |
| H6 | Synthetic dining areas identified by magic strings `__walk_in__` / `__delivery__`, positions 999/998 | `takeaway.service.ts:266-289`, `delivery-hub.service.ts:135-164` | OPEN |
| H7 | `CODE_DEFAULTS` duplicates Prisma column defaults in three places | `restaurant-config.service.ts:21-27`, `:90-93` | OPEN |
| H8 | Open-table code uses a tenant-global unpadded sequence; `@@unique([areaId, code])` enforces nothing when `areaId` is NULL | `dining.service.ts:371-379` | OPEN |

---

## Verified clean

No hardcoded seed ids (`tnt_`, `brn_`, `reg_`, `usr_`, `prd_`, `cat_`) anywhere
in production code. The service-charge read in `closeSession` is done correctly
and is the pattern the tax fix should copy.

## One claim checked and rejected

An audit pass reported that "a restaurant cannot record a takeaway order through
the API" because `createOrder` hardcodes `RestaurantOrderChannel.DINE_IN`
(`table-sessions.controller.ts:105`). **This is wrong** — takeaway has its own
module and endpoint which correctly sets `channel: TAKEAWAY`
(`takeaway.service.ts:88`). The real, smaller finding is that
`SubmitRoundDto.channel` is dead validation on the dine-in path.

## Suggested sequencing

1. **A + B** — bills are wrong and unreconcilable. B2 needs no new API.
2. **C** — guests charged for food nobody was told to cook.
3. **F + D5/D6** — currency and business name on customer documents. Cheaper
   than first scoped: the settings already exist and in several places are
   already fetched and then ignored.
4. **D1/D2** — a settings surface, since much of the config exists and is only
   unreachable.
5. **E** — the genuinely missing configuration.
6. **G, H** — pilot-scope cleanup and correctness.
