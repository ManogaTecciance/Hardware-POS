# Manual QA Checklist — Hardware POS

Click-through verification before every release. Tick each box; log defects with the case ID.
Use `[x]` pass, `[!]` fail (add a note), `[-]` blocked/N-A.

**Build under test:** ________  **Date:** ________  **Tester:** ________  **Env:** ☐ local ☐ staging

**Test accounts** (tenant `tnt_dev`): Owner `owner@hardwarepos.test`/`password123` ·
Salesperson `salesperson@hardwarepos.test`/`password123` ·
Accountant `accountant@hardwarepos.test`/`password123` · Manager PIN `2222` · Cashier PIN `1111`.

**Preconditions**
- [ ] API and Web running; DB migrated + seeded.
- [ ] QuickBooks connected (sandbox) for sync areas — `/quickbooks` shows *Connected*.

---

## 1. Login
- [ ] Open `/login`; sign in as Owner (email/password) → lands on `/dashboard` (or `/pos`).
- [ ] Sign out; sign in as Cashier via **PIN** `1111` → success.
- [ ] Wrong password / wrong PIN → clear error, no session created.
- [ ] Header shows the logged-in user, role, branch/register, and sync status.
- [ ] Refresh keeps the session; expired/invalid session redirects to `/login`.

## 2. Product sync (QuickBooks → POS)
- [ ] As Owner open `/quickbooks/products`; click **Sync Products**.
- [ ] Result tiles show **Created / Updated / Skipped / Failed** with sensible numbers.
- [ ] Non-inventory items imported; service items counted as **Skipped**.
- [ ] Product list/price/on-hand reflect QuickBooks; re-running shows mostly **Updated**.
- [ ] As Cashier the **Sync Products** action is hidden/disabled (no `quickbooks:manage`).
- [ ] A sync-log entry appears under `/quickbooks/sync-log`.

## 3. Product search
- [ ] On `/pos`, search by **name** — list filters as you type.
- [ ] Search by **SKU** and by **barcode** — correct product found.
- [ ] Category tabs filter the grid.
- [ ] Inactive products are excluded (or clearly marked) from sale.
- [ ] Empty search shows the default grid (no crash).

## 4. Add to cart
- [ ] Tap a product → added to cart (qty 1), line total = unit price.
- [ ] Tap the same product again → quantity becomes 2 (one line, not two).
- [ ] Cart shows subtotal, total discount, tax, and total.
- [ ] Remove a line → totals update; empty cart disables **Payment**.
- [ ] An **invoice date** selector sits directly above the customer dropdown and shows today.
- [ ] An earlier date can be picked; it survives going to Payment and back.
- [ ] A future date cannot be picked, and the API refuses one if forced.
- [ ] After completing a backdated sale, the selector is back to today.

## 5. Quantity change
- [ ] Increment/decrement quantity → line total and cart totals recompute.
- [ ] Set quantity above stock → blocked or flagged; completing is prevented server-side.
- [ ] Item note button attaches a note to the line.

## 6. Product-wise discount
- [ ] As Owner, open **Discount** on a line; apply **10%** → line total drops, preview correct.
- [ ] Apply a **fixed** discount → amount never exceeds the line subtotal.
- [ ] Enter a discount **reason**; it is retained.
- [ ] Total discount on the cart equals the sum of line discounts.

## 7. Manager approval
- [ ] As **Cashier**, apply a discount → **Manager approval** modal appears (cashier limit 0%).
- [ ] Enter Manager PIN `2222` with a value **≤15%** → approved; discount applies; token stored on the line.
- [ ] Try **>15%** with Manager PIN → **rejected** (over manager cap).
- [ ] Wrong Manager PIN → rejected, no approval.
- [ ] Complete the approved sale → succeeds; approver recorded.

## 8. Cash payment
- [ ] Checkout → choose **Cash**, amount = total → **Complete Sale**.
- [ ] Success screen: sale number, amount paid, **balance 0**, sync status **Waiting to Sync**.
- [ ] **Print customer receipt** and **New sale** buttons work.

## 9. Card payment
- [ ] Complete a sale with **Card**, capture a reference → success, balance 0.
- [ ] Try Bank Transfer / QR Payment / Cheque → each completes.

## 10. Partial payment
- [ ] Select a **customer**, pay **less than total** → success screen shows a **balance due**.
- [ ] Sale is recorded as **credit/partial** (Invoice type); balance visible in `/sales`.
- [ ] Attempt a partial/credit sale **without** a customer → blocked with a clear message.

## 10a. Payment due date & settlement
- [ ] Choosing **Credit** or **Partial** reveals a required **Payment due date**; Complete Payment
      stays disabled until it is set, and says so.
- [ ] Switching back to a **full** payment hides the field, and the sale completes without one.
- [ ] A due date **earlier than the invoice date** is refused (try it on a backdated sale).
- [ ] The sales list shows the **Due** date for that sale and "—" for a fully paid one.
- [ ] The **Overdue** filter lists only sales past due that still owe; exporting from the filtered
      view covers the same sales.
- [ ] Credit is settled on the CUSTOMER, not the invoice: the sale detail has no Record payment
      button, and the customer page has one.
- [ ] Customer page → **Record payment**: part-pay an account with two credit sales on it. Both
      sales still read **Credit** — not even the older one is settled — and the Credit history
      lists the payment.
- [ ] Pay the rest. Both sales flip to **Paid** together, and the account reads zero.
- [ ] Ring up another credit sale for the same customer. It reads Credit; the settled ones stay
      Paid; the account balance is just the new sale.
- [ ] Paying **more** than the account owes is refused.
- [ ] The customer's **Available credit** on /customers rises by what was settled.
- [ ] The dashboard's **Credit Receivable** card falls by the same amount and, clicked, opens the
      customers list filtered to those who still owe.
- [ ] The A4 bill shows the **payment method**: "Credit" while a balance remains, "Cash, Credit"
      for a part payment, and the real method(s) once settled — plus the **Payment due** date.
      Check the bill printed from the app (`/print/sales/{id}`), not only the API's PDF.

## 11. Receipt print
- [ ] Customer receipt renders with lines, discounts, totals, paid/balance; browser **Print** works.
- [ ] A sale containing a **warehouse-pickup** product also produces a **warehouse picking copy** (pickup items only).
- [ ] Mark a print job as printed → status updates.
- [ ] A **backdated** sale prints the picked invoice date, not today's date.

## 12. QuickBooks Sales Receipt sync (fully paid)
- [ ] Take a **fully-paid** sale; trigger sync (auto by worker, or **Sync** action).
- [ ] Within a few seconds the sale shows **Synced** with a **Sales Receipt** id.
- [ ] In QuickBooks sandbox a matching Sales Receipt exists; line items reference the right items; discount reflected in the amount/description.
- [ ] Re-syncing does **not** create a duplicate.
- [ ] A **backdated** sale is filed in QuickBooks under the picked date (check the transaction date in the sandbox).

## 13. QuickBooks Invoice + Payment sync (credit / partial)
- [ ] A **partial** sale syncs as an **Invoice**; the paid amount posts as a linked **Payment**.
- [ ] Sale shows the **Invoice** id; the payment shows a QuickBooks payment id.
- [ ] In the sandbox the Invoice + Payment are linked and balances match.
- [ ] On a backdated credit sale, the Invoice **and** its Payment both carry the picked date.
- [ ] A pure **credit** sale (paid 0) posts an Invoice with **no** payment.

## 14. Failed sync retry
- [ ] Simulate a failure (disconnect QuickBooks or use a forced-failure sandbox), complete a sale.
- [ ] Sale stays saved and shows **Sync Failed** with an error message (nothing lost).
- [ ] `/quickbooks/sync-log` shows the failed attempt(s).
- [ ] Restore QuickBooks; click **Retry Sync** → sale re-queues and reaches **Synced**.
- [ ] After repeated failures the sale is marked **Failed** (not stuck "syncing") and can still be retried.

## 15. Role access
- [ ] **Cashier**: can sell + take payment; **cannot** see QuickBooks connect/sync-products or sync logs.
- [ ] **Manager**: can approve discounts; cannot connect QuickBooks or run product sync.
- [ ] **Accountant**: can view **sync logs** and **QuickBooks status**; cannot create sales or take payment.
- [ ] **Owner/Admin**: full access — connect QuickBooks, sync products/sales, settings, users.
- [ ] **Salesperson**: identical to Owner on every check above — same nav, same QuickBooks
      connect/sync access, same settings and user management, unlimited discounts.
- [ ] Deep-linking to a forbidden route (e.g. Cashier → `/quickbooks/settings`) is blocked/redirected.
- [ ] Directly calling a forbidden API returns **403**; missing token returns **401**.

---

## Cross-cutting checks
- [ ] Errors surface as friendly messages (not raw stack traces); the `{ data }` envelope is consistent.
- [ ] Money always shows 2 decimals; no rounding drift on discounts/tax/totals.
- [ ] Large touch targets; keyboard/tab order sane on `/pos`.
- [ ] Tokens never appear in the browser (network tab, localStorage) for QuickBooks — backend only.
- [ ] No console errors on the main flows.

**Result:** ☐ Pass ☐ Pass w/ notes ☐ Fail  **Defects logged:** ______________________
