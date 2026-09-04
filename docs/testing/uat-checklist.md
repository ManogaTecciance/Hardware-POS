# User Acceptance Test (UAT) Checklist — Hardware POS

For the business owner / client team to confirm the system does what the shop needs before
go-live. Each scenario is written in plain language with a clear **pass** condition. Tick **Accepted**
or **Rejected** and add comments. Nothing here requires technical knowledge.

**Reviewer:** ____________________  **Role:** ____________________  **Date:** ____________
**Environment:** ☐ Demo/sandbox ☐ Live-pilot

**Sign-in details provided to you**

| Who | How they sign in |
| --- | --- |
| Owner/Manager | Email + password |
| Salesperson | Email + password |
| Cashier | 4-digit PIN |
| Accountant | Email + password |

> QuickBooks Online should already be connected to the demo company for these tests.

---

### Scenario 1 — Staff can sign in the way they work
- Cashiers sign in quickly with a **PIN**; managers/owners sign in with **email + password**.
- A wrong PIN or password does not let anyone in.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 2 — Stock and prices come from QuickBooks
- Products, prices and quantities in the POS match QuickBooks.
- Pressing **Sync Products** brings across any new or changed items.
- Staff **cannot edit stock inside the POS** — QuickBooks stays the source of truth.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 3 — Finding products is fast
- A cashier can find a product by **name, code (SKU) or barcode**, and by **category**.
- The right product appears without confusion.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 4 — Ringing up a sale
- Adding items to the cart is quick; tapping an item again increases its quantity.
- Quantities can be changed, and the running **total is always correct**.
- The system prevents selling more than is in stock.
- A sale can be dated to the day it actually took place; the system refuses a future date.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 5 — Discounts with the right controls
- A cashier can give a **line discount** (percentage or fixed) with a reason.
- Discounts **above the cashier's limit require a manager's approval** (manager enters their PIN).
- A manager cannot approve beyond **their** limit either.
- The customer total reflects the discount accurately.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 6 — Taking payment, all the usual ways
- **Cash** and **Card** sales complete and show a clear success screen (amount paid, balance).
- Other methods used by the shop (Bank Transfer, QR, Cheque) also work.
- A **partial payment / pay-later** sale records the **balance owed** against a customer.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 7 — Receipts
- A **customer receipt** prints (or opens to print) with the correct items, discounts and totals.
- For items that are picked from the warehouse, a **warehouse picking copy** is produced.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 7a — Selling on credit and collecting later
- When a customer takes goods without paying in full, the till **asks when payment is due** and
  will not complete the sale until it is given.
- The **bill shows** how the customer paid (cash, card, …) and when the balance falls due.
- The customers list shows each customer's **available credit** — their limit less what they owe.
  A customer with no limit set shows nothing there, not zero.
- When the customer pays, staff record it from the sale: **amount, method, reference**. Paying in
  instalments is fine — each payment is listed with its own date and time.
- Once the balance reaches zero the sale reads **Paid**, and the customer's available credit is
  free to use again.
- The sales list can be filtered to **overdue** payments, and shows when each customer last paid.
- The dashboard shows the **total owed to the shop**, and clicking it lists exactly who owes it.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 8 — Sales flow into QuickBooks automatically
- A **fully paid** sale appears in QuickBooks as a **Sales Receipt**.
- A **credit / partial** sale appears as an **Invoice**, and any amount paid shows as a **Payment** against that invoice.
- That Invoice carries the **due date agreed at the till**, so QuickBooks ages the debt correctly.
- Note: a payment **recorded later** in the POS does not yet reach QuickBooks — the accountant
  still applies it there.
- The figures in QuickBooks match the POS. No duplicates are created.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 9 — Nothing is lost if QuickBooks is unavailable
- If QuickBooks is temporarily down, the **sale is still saved** in the POS and marked **“Sync Failed / Waiting.”**
- When QuickBooks is back, the sale **syncs automatically**, or the owner can press **Retry Sync**.
- The owner/accountant can see a **log** of what synced and what failed.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 10 — The right people can do the right things
- **Cashiers** can sell and take payments but cannot change QuickBooks settings.
- **Managers** can approve discounts.
- **Accountants** can review sync logs and QuickBooks status.
- **Owners/Admins** can do everything, including connecting QuickBooks and managing users.
- **Salespeople** have the same access as an owner.

**Accept?** ☐ Yes ☐ No — Comments: ____________________

### Scenario 11 — Everyday resilience & clarity
- Error messages are understandable, not technical jargon.
- Amounts always show two decimals and add up correctly.
- The screen is easy to use on the shop's device (buttons large enough, quick to tap).

**Accept?** ☐ Yes ☐ No — Comments: ____________________

---

## Overall acceptance

| | |
| --- | --- |
| Scenarios accepted | ______ / 11 |
| Critical defects outstanding | ______ |
| Decision | ☐ Accept for go-live ☐ Accept with conditions ☐ Reject |

**Conditions / follow-ups:**

_______________________________________________________________________

**Client sign-off:** ____________________  **Signature/Date:** ____________________
**Vendor sign-off:** ____________________  **Signature/Date:** ____________________
