# POS Features

> Placeholder — none of these are implemented yet. This lists the planned
> cashier front-end scope.

## Core features

- **PIN login** — quick cashier authentication
- **Product search** — search the local product cache
- **Barcode search** — scan to add products
- **Product grid** — browse products visually
- **Cart** — add / edit / remove line items
- **Product-wise manual discount** — per-line discounts
- **Manager PIN approval** — required for high discounts
- **Invoice date** — date a sale to when it actually happened (shop timezone); forward dating blocked
- **Customer selection** — attach a customer to a sale
- **Payment** — capture payment(s)
- **Payment due date** — required when a sale leaves a balance; never before the invoice date
- **Record payment received** — settle a credit sale later, in full or in instalments
- **Available credit** — each customer's limit minus what they currently owe
- **Receipt print** — print / reprint receipts (payment method and due date appear on the bill)
- **Sales history** — view past sales, with an overdue filter
- **QuickBooks sync status** — see per-sale sync state
- **Sync log and retry** — inspect and retry failed syncs

## Recommended first scope

1. QuickBooks connection
2. Product sync
3. POS checkout
4. Product-wise discount
5. Payment + receipt
6. Sales sync + sync log
