# Requirements

Hardware POS — a cashier sales front-end connected with **QuickBooks Online (QBO)**.

QBO stays the system of record. The POS is a fast, offline-tolerant checkout terminal
that reads catalog/inventory data from QBO and pushes completed sales back to it.

## 1. Source-of-truth boundary

QuickBooks Online is authoritative for:

- Products / items
- Inventory (quantity on hand)
- Prices
- Accounting (ledgers, taxes, chart of accounts)
- Reports

The POS is authoritative for:

- Cashier sessions and login
- The in-progress cart
- Manual, product-wise discounts applied at the till
- The local sales record and its sync state

> **Rule:** the POS never edits stock or prices directly in QBO. It only creates
> Sales Receipts, Invoices, and Payments. Inventory decrements happen in QBO as a
> side effect of those documents.

## 2. Actors / roles

| Role      | Capabilities                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| Cashier   | Log in with PIN, search products, build a cart, take payment, print receipts |
| Manager   | Everything a cashier can do, plus approve high discounts, view all sales     |
| Admin     | Manage users, configure the QBO connection, view sync logs, retry syncs      |
| Owner     | Everything — the full permission set, with no discount ceiling               |
| Accountant| Read sales, sync logs and QuickBooks status; no selling or editing           |
| Salesperson | Owner-equivalent: the same full permission set and no discount ceiling     |

## 3. Functional requirements

### 3.1 Authentication

- **FR-1** Cashiers log in with a numeric PIN.
- **FR-2** A discount above a configurable threshold requires a **manager PIN** to approve
  (manager does not need to log out the cashier; it is an inline approval).

### 3.2 Catalog & search

- **FR-3** Product search by name / SKU against the local product cache.
- **FR-4** Barcode search: scanning a barcode resolves to a single product and adds it to the cart.
- **FR-5** The product cache is refreshed from QBO on a schedule and on demand.

### 3.3 Cart & pricing

- **FR-6** Add, update quantity, and remove line items.
- **FR-7** Apply a **product-wise manual discount** (percentage or fixed amount) per line item.
- **FR-8** Show running subtotal, discount total, tax, and grand total.
- **FR-9** Discounts at or below the threshold apply immediately; above it, they are held
  pending manager approval before the sale can complete.

### 3.4 Customer

- **FR-10** Optionally attach a customer (searched from the local customer cache) to a sale.
- **FR-11** A customer is **required** for credit/partial sales (invoices), optional for cash sales.
- **FR-19** Show each customer's **available credit** on the customers list: their credit limit
  minus everything they currently owe across completed, unsettled sales. A customer with no
  limit configured shows **nothing** — not zero, which would read as "no credit left".
- **FR-20** Let the customers list be filtered to customers who currently have credit
  outstanding, and make that filter addressable by URL so the dashboard can link into it.

### 3.5 Payment & completion

- **FR-12** Take payment (cash, card — recorded as a payment method + amount).
- **FR-13** Determine the transaction type from amount paid vs. total (see §4).
- **FR-14** Persist the sale locally first, then enqueue it for QBO sync.
- **FR-15** Set the **invoice date** from the POS cart (a date selector directly above the
  customer dropdown, defaulting to today) so a sale can be recorded on the day it actually
  took place. The chosen date is the one printed on the invoice and receipt, the date the
  transaction is filed under in QuickBooks, and the date the sale is placed under in the
  sales history and dashboard figures.
- **FR-16** Reject a **future** invoice date. Stock is still adjusted at completion time,
  regardless of the date chosen.
- **FR-17** Store every date and time as a **UTC instant**. Convert to a timezone only when
  displaying: on-screen values use the **viewer's own** device timezone (read from the browser),
  while printed and emailed documents — invoice, receipt, PDF/XLSX reports — use the configured
  **shop timezone**, so one document reads the same date for everyone who opens it.
- **FR-18** Let an owner/admin set the shop timezone in Settings (IANA name; default `Asia/Colombo`).
- **FR-21** Require a **payment due date** when completing a sale that leaves a balance, and
  reject one on a fully paid sale, which owes nothing. The due date may not fall before the
  invoice date — a backdated sale may therefore be recorded already overdue.
- **FR-22** Send the payment due date to QuickBooks as the Invoice `DueDate`, and print it on
  the bill alongside the payment method(s) used.
- **FR-29** Let a fixed item discount be taken **off each unit** or **off the line as a whole**,
  chosen at the moment it is applied and shown with its arithmetic before it is committed, in the
  POS cart **and** when building a quotation. A percentage offers no such choice, being the same
  figure either way. The whole-cart discount is always whole-cart.
- **FR-31** Make the two kinds tellable apart wherever a discount is shown — the cart line, the
  quotation builder and detail, and the printed bill and quotation, which spell out
  `value × quantity` for a per-unit amount so the figure can be checked.
- **FR-32** Carry the basis through quotation revisions and through conversion to a sale: a
  quotation must be invoiced at the price it was quoted.
- **FR-30** Mark products that do not track stock (Service, Non-Inventory) on the POS product
  card, so a cashier can see why a card shows no quantity.
- **FR-27** Show the customer's credit position on the POS payment screen while the order is
  being built — available credit, what this sale needs, and a clear warning when it would
  breach the limit — so the cashier learns of it as quantities change rather than when they
  press Complete Payment. The screen mirrors the server rule exactly but never replaces it:
  the server re-checks on completion, and a screen that cannot read the figure must not
  block the sale.
- **FR-26** State the payment method on customer documents as **Credit** while a balance
  remains — beside anything already tendered — and as the real method(s) once the sale is
  settled, so a bill reprinted after payment names how the customer actually paid.

### 3.6 Receipt

- **FR-15** Print a receipt on completion and support reprint from sales history.

### 3.7 History & sync visibility

- **FR-16** Sales history list with per-sale **sync status** (pending / syncing / synced / failed).
- **FR-17** A **sync log** view showing each sync attempt, its result, and any error.
- **FR-18** Manual **retry** of a failed sync.
- **FR-23** **Record a payment received** against a customer's CREDIT ACCOUNT, from their
  customer page, capturing the amount, method and an optional reference. Payments accumulate:
  each is kept as its own record with its own date and time. Credit is settled per account,
  not per invoice — while the account owes anything every credit sale stays outstanding, and
  the moment it reaches zero every sale outstanding at that moment is marked paid. A sale rung
  up afterwards starts the next balance. The customer page carries the credit history.
- **FR-28** Money paid on account releases the customer's credit headroom, and comes off the
  shop's receivable, the moment it is taken — even before it settles any invoice.
- **FR-24** Show on the sales list, per sale: the **due date** (blank when nothing is owed),
  the **last payment received** (blank for a sale that never ran on credit), and offer an
  **overdue** filter — past its due date and still owing. Report exports honour the same filter.
- **FR-25** Show the shop's **total outstanding receivable** on the dashboard, as a running
  total unaffected by the dashboard's date range (money owed does not stop being owed at
  midnight). Clicking it opens the customers list filtered to those who owe.

## 4. Transaction rules

| Condition                          | POS records        | Pushed to QuickBooks Online      |
| ---------------------------------- | ------------------ | -------------------------------- |
| Amount paid **>= total** (paid)    | Sale (type RECEIPT) | **Sales Receipt**                |
| Amount paid **< total** (credit)   | Sale (type INVOICE) | **Invoice** + **Payment** for the amount paid |
| Return / exchange                  | *(phase 2)*        | Refund / Credit Memo flow *(later)* |

- A fully paid sale carries no balance and maps cleanly to a Sales Receipt.
- A partial/credit sale creates an Invoice for the full amount, then a Payment applied to it
  for the portion collected; the remaining balance stays open in QBO.

## 5. Non-functional requirements

- **NFR-1 Fast checkout:** product lookup and add-to-cart respond from the local cache
  (target < 100 ms), independent of QBO latency.
- **NFR-2 Resilient sync:** if QBO is unreachable, the sale is saved locally and retried;
  no sale is lost because sync failed.
- **NFR-3 Idempotency:** retries must not create duplicate QBO documents (see
  [quickbooks-integration.md](./quickbooks-integration.md)).
- **NFR-4 Auditability:** every sync attempt is logged with timestamp, status, and error.
- **NFR-5 Security:** PINs are stored hashed; QBO OAuth tokens are stored encrypted at rest.

## 6. Out of scope (for now)

- Returns / exchanges / refunds (planned as a later phase).
- Editing products, prices, or stock from the POS.
- Multi-currency and automatic currency conversion. The POS operates entirely in LKR (Sri Lankan Rupees); the connected QBO company currency is expected to be LKR and a warning is shown if it is not.
- Purchase orders and supplier management (handled in QBO).
