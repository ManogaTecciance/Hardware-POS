# Auto-printing plan — bills to the cashier printer, KOTs to the kitchen printer

**Status:** proposal, awaiting PO sign-off on the open decisions in §14.
**Author:** engineering, 2026-08-18.
**Scope:** `apps/api`, `apps/web`, `packages/database`, one **new** deployable (`apps/print-agent`).
**Extends:** D53 (food always reaches the kitchen), D54 (tenant-branded documents), D46/D65 (round intake + depletion), the Phase 6 KOT machinery, and the Slice 4 retail print-job queue.
**Relates to:** `docs/convergence-plan.md` §4.10 (what stays closed) — printing is an *edge* concern and deliberately does not touch the settlement or catalogue core.

---

## 0. The requirement, restated

> When an order is placed and sent to the kitchen, the bill should print on the
> cashier's printer and the kitchen tickets should print on the kitchen
> printer(s) — **automatically**, with no tap on either screen.

Unpacked into the two behaviours the system must guarantee:

1. **Kitchen auto-print.** The moment a round is submitted (dine-in table
   round, counter order, takeaway, delivery), every KOT the round generates is
   physically printed on the printer(s) configured for its kitchen station —
   grill tickets on the grill printer, bar tickets on the bar printer — without
   anyone touching the kitchen display.
2. **Cashier auto-print.** At the same moment, the cashier's own printer
   prints the customer-facing document for the order. *Which* document depends
   on the flow (see §9.3): a **receipt** where payment happens at placement
   (counter flows), a **pro-forma order bill** where it does not (dine-in
   table service, delivery).

And the implicit third requirement that makes the first two honest:

3. **Failure is visible, never silent.** A printer that is off, out of paper,
   or unreachable must not make an order disappear (D53's rule — the round
   always commits) **and** must not pretend it printed. The operator sees the
   failure where they work (KDS banner, POS toast), can reprint with one tap,
   and the queue drains automatically when the printer comes back.

### Non-goals of this plan

- Label printers, sticker formats, or barcode printing.
- Customer-facing e-receipts (email/SMS/QR) — different channel, own plan.
- Cash-drawer kick is **specified** (§8.6, the ESC/POS pulse rides the same
  payload) but shipping it is optional scope in Phase 4.
- Multi-copy routing policies beyond "N copies on one printer" (e.g. "print
  the bill on the cashier printer AND the pass printer") — the data model
  (§7) supports it; the UI for it is deferred.

---

## 1. Definitions

| Term | Meaning here |
|---|---|
| **KOT** | Kitchen Order Ticket — one `KitchenTicket` per (round × station), listing that station's items. Already generated today. |
| **Bill** | The customer-facing order document at the cashier. Two flavours: **receipt** (payment settled — has payment lines) and **pro-forma** (order placed, unpaid — "not a tax invoice"). |
| **Cashier printer** | The thermal printer physically at a register. Assigned per **Register**, falling back to a per-branch default (§7.3). |
| **Kitchen printer** | A `KitchenPrinter` row, already modelled, reached through `KitchenStationPrinter` links. |
| **Print Agent** | The new on-site daemon that physically drives printers (§10). One per shop network (usually one per branch). |
| **Outbox row** | A database row representing "this must print": `KitchenPrintAttempt` (exists) and `PrintJob` (exists, widened in §7.2). The row is written in the order's own transaction; the printing happens after commit. |

---

## 2. Current state — what exists today

This section is an inventory, file-accurate as of `fcbbecd`. The design in
§5+ deliberately *completes* this machinery rather than replacing it — most
of the outbox was built for exactly this and is simply not driven yet.

### 2.1 Kitchen side — a complete outbox with no driver

- **Models** (`packages/database/prisma/schema.prisma`):
  - `KitchenStation` — per-branch station (`code`, `name`, `category`), linked
    to products via `ProductStationLink` (D45/D46 routing).
  - `KitchenPrinter` — per-branch printer: `code`, `name`, `address`, and
    `kind ∈ {ESC_POS_NETWORK, ESC_POS_USB, A4_NETWORK, MOCK}`. CRUD exists at
    `/restaurant/branches/:branchId/kitchen-printers` (KITCHEN module).
  - `KitchenStationPrinter` — station↔printer junction with `isPrimary`.
  - `KitchenTicket` (`status ∈ {QUEUED, PRINTED, REPRINTED, FAILED}`) +
    `KitchenTicketItem` (name, variant, qty, modifiers, instructions — the
    full print payload already snapshotted) + `KitchenPrintAttempt`
    (`status ∈ {PENDING, …}`, `printerId`, `error`, timestamps).
- **Generation** (`apps/api/src/modules/kitchen/kitchen.service.ts`):
  `generateTicketsForRound(tx, …)` runs INSIDE the round transaction from both
  intake paths (`table-sessions.service.submitRound` and
  `takeaway.service.create` — since 2026-08-18 both ride the shared
  `round-item-resolution.ts`). It creates one QUEUED ticket per station and
  one PENDING `KitchenPrintAttempt` per configured printer. Its own comment
  states the gap this plan closes: *“the actual print attempts (which may hit
  a network printer) are queued as PENDING rows and are **not driven here**.”*
- **Manual controls** (`kitchen-tickets.controller.ts` + the web
  `kitchen-board.tsx`): `mark-printed`, `mark-failed`, `reprint` — a human
  presses a button per ticket. This is today's only way a ticket leaves
  QUEUED.
- **KDS** (`kds.controller.ts` → `/restaurant/branches/:id/kds/board`): the
  live board the kitchen watches.

**Verdict:** the kitchen data model was built for auto-print and needs almost
no schema change. What is missing is (a) a process that turns PENDING
attempts into bytes on a wire, and (b) ESC/POS rendering.

### 2.2 Cashier side — browser popups and an audit-only queue

- **Model:** `PrintJob` — `saleId` (required), `type ∈ {CUSTOMER_RECEIPT,
  WAREHOUSE_PICKING, RETURN_RECEIPT}`, `status ∈ {PENDING, PRINTED, FAILED}`,
  and an `html` payload column. Endpoints: `GET /print-jobs`,
  `POST /print-jobs/:id/mark-printed` (RETAIL_POS-gated).
- **Actual printing** is browser-driven and manual:
  - Thermal-ish receipts: `apps/web/src/lib/receipt-print.ts` opens a named
    popup with server-rendered (or fallback client) HTML and calls
    `window.print()` — the operator confirms the browser dialog.
  - A4 bills: `/print/sales/[saleId]?print=1` renders a shell-free page and
    auto-opens the browser dialog.
  - PDFs: `GET /documents/sales/:saleId` (D54 — tenant branding, currency).
- The `PrintJob` queue is written by `ReceiptsService` but **nothing polls
  it**; it functions as an audit trail plus a manual re-print source.

**Verdict:** the cashier side has documents and a queue but no printer
concept at all (no cashier-printer registry, no assignment to a register)
and no non-interactive print path.

### 2.3 The flows that must trigger auto-print

| Flow | Intake call | Sale exists at placement? | Today's print behaviour |
|---|---|---|---|
| Dine-in, table service | `POST /restaurant/orders/:id/rounds` (per round) | No — Sale on `closeSession` | KOT queued, never printed; bill via browser at close |
| Counter “Dine In” / Takeaway | `POST /restaurant/takeaway` → `HANDED_OVER` → Sale → payment | Yes, seconds later | KOT queued, never printed; no receipt print at all in the popup flow |
| Delivery (THIRD_PARTY) | same takeaway path, Sale on handover later | No | same |
| Retail counter (hardware tenants) | `POST /sales/complete` | Yes, immediately | receipt via browser popup, operator-confirmed |

### 2.4 Deployment topology (why this constrains the design)

Production: web on Amplify (`axlopos.com`), API on a single EC2 behind Caddy
(`api.axlopos.com`). Printers live on the **shop's LAN** (RFC1918 addresses,
usually raw TCP 9100). The cloud API can never open a socket to
`192.168.1.50:9100` inside a customer's shop. **Whatever drives printers must
run on-site.** This single fact drives the architecture choice in §5.

---

## 3. The gap, precisely

1. Nothing drives `KitchenPrintAttempt` rows → tickets sit QUEUED forever
   unless a human taps the board.
2. There is no cashier-printer registry, no register→printer assignment, and
   no bill/receipt outbox row is written at order placement.
3. There is no ESC/POS rendering anywhere — payloads today are HTML/PDF,
   which thermal printers do not speak natively.
4. There is no on-site component that can reach a LAN printer from the
   production deployment.
5. There is no per-branch configuration for "auto-print on place: yes/no",
   copies, or which document flavour prints.

---

## 4. Requirements

### 4.1 Functional

- F1. Submitting a round (any intake path) enqueues, in the SAME database
  transaction as the round: (a) the KOT attempts (exists) and (b) one cashier
  bill job (new).
- F2. Within ≤ 3 seconds of commit under normal conditions, the physical
  printers produce the KOTs and the bill (target; see NFRs).
- F3. Per-branch switches: `autoPrintKot` (default **on**), `autoPrintBill`
  (default **on**), plus copies per document type.
- F4. Reprint stays one tap from the KDS/kitchen board (exists) and gains an
  equivalent on the POS/bills side.
- F5. A printer/agent failure surfaces within 30 s where the operator works,
  names the printer, and auto-recovers when the device returns (queue drains
  in order, no duplicates).
- F6. Everything continues to work with **no** agent installed: the current
  browser print paths remain, and a branch can run "browser fallback" mode
  (kiosk auto-print, §5 option A) indefinitely.
- F7. Retail tenants get the same machinery for receipts (`PrintJob` today is
  theirs) with zero behaviour change until their branch opts in.

### 4.2 Non-functional

- N1. **At-least-once with visible dedupe:** a ticket must never be lost;
  a duplicate physical print is tolerable but must be rare and always
  operator-attributable (reprint) or crash-window (§10.6), never steady-state.
- N2. The order transaction NEVER waits on a printer (D53 — already true for
  KOTs; must stay true for bills).
- N3. Agent ↔ API traffic works over plain HTTPS egress (shops have NAT, no
  inbound ports, often flaky DNS): the agent always dials out.
- N4. One agent binary/config supports N printers across kitchen + cashier
  roles.
- N5. Everything observable from the cloud: last-seen per agent, per-printer
  success/failure counters, queue depth per branch.

---

## 5. How printing physically happens — options and decision

### Option A — browser kiosk printing (no new deployable)

The web app (POS tab / KDS tab) polls the queues it can already read and
prints via `window.print()` into a receipt-CSS page. With Chrome launched as
`chrome --kiosk-printing` the dialog is suppressed and the OS default printer
prints silently.

- ✅ Zero new infrastructure; works tomorrow; uses OS drivers (any printer).
- ❌ One OS default printer per device → the *same tab* cannot drive the
  kitchen printer AND the cashier printer; you need one dedicated
  always-open tab per printer, logged in, with the right OS default.
- ❌ Fragile (tab closed = printing stops silently), no paper-out feedback,
  HTML rendering on thermal via OS driver is slow and cuts badly.
- **Verdict:** not the system, but a **credible fallback mode** — kept and
  formalised (§9.5) because it is also the only option for a tenant with a
  USB-only printer on a locked-down POS PC where we cannot install anything.

### Option B — API prints directly to the printer

`kitchen.service` opens TCP 9100 to `printer.address` after commit.

- ✅ Simplest code path; great for on-prem installs and local dev.
- ❌ Impossible from the cloud API to a shop LAN (§2.4). Dead on arrival for
  production. Kept ONLY as a dev-mode driver inside the agent codebase.

### Option C — a local Print Agent driving the existing outbox ✅ **recommended**

A small headless service installed on any always-on machine in the shop (the
POS PC itself, the KDS box, or a ₨-cheap SBC). It authenticates with a
branch-scoped **agent token**, long-polls the API for work (`lease → print →
ack/nack`), renders nothing itself (payloads arrive as ready ESC/POS bytes,
§8), and drives:

- `ESC_POS_NETWORK` — raw TCP 9100 to the printer's LAN address;
- `ESC_POS_USB` — via the OS (escpos-usb / printer spool passthrough);
- `A4_NETWORK` — IPP/driver print of the PDF variant (post-MVP, §16);
- `MOCK` — writes the payload to a spool directory (dev/tests, exists in the
  enum today for exactly this).

- ✅ Matches the schema that already exists (PENDING attempts *are* the work
  queue). ✅ Outbound-only HTTPS. ✅ One agent, many printers, both roles.
  ✅ Server keeps full observability (every attempt acked with outcome).
- ❌ One new deployable to build, version, and support (§10.8 keeps this
  small: single static binary, one JSON config, systemd/NSSM service).

### Option D — QZ Tray / WebUSB / Web Bluetooth

Browser-adjacent local bridges. QZ Tray is licensed and certificate-fiddly;
WebUSB thermal support is patchy and Chrome-only; both still need per-device
setup ≈ the effort of our own agent without owning the roadmap.
**Rejected** as the primary path; nothing in the design precludes a tenant
using QZ against the same queue API later.

> **Decision (for the record when implemented, D67):** Option C — a local
> Print Agent draining the existing outbox rows, with Option A formalised as
> the no-agent fallback mode, and Option B's socket code living inside the
> agent as its network driver.

---

## 6. Target architecture

```
                     order placed (any intake path)
                                  │
              ┌───────────────────┴──────────────────────┐
              │  ONE DB TRANSACTION (unchanged D53 rule) │
              │  round + items + depletion               │
              │  KitchenTicket(QUEUED)                   │
              │   └─ KitchenPrintAttempt(PENDING) × N    │
              │  PrintJob(PENDING, kind=BILL) ← NEW      │
              └───────────────────┬──────────────────────┘
                                  │ commit
                    (nothing below can fail the order)
                                  │
        ┌─────────────────────────┼─────────────────────────────┐
        │ API: render worker      │                             │
        │ ESC/POS payload per     │  GET /print-agent/lease     │
        │ attempt/job (§8), or    │◄────────────────────────────┤
        │ lazily at lease time    │        long-poll 25s        │
        └─────────────────────────┘                             │
                                              ┌─────────────────┴───────────────┐
                                              │  PRINT AGENT (on-site, §10)     │
                                              │  token: branch-scoped           │
                                              │  drivers: tcp9100 / usb / mock  │
                                              └───────┬───────────────┬─────────┘
                                                      │               │
                                             ESC/POS bytes      ESC/POS bytes
                                                      ▼               ▼
                                            ┌──────────────┐  ┌──────────────┐
                                            │ KITCHEN PRN  │  │ CASHIER PRN  │
                                            │ (per station)│  │ (per register)│
                                            └──────────────┘  └──────────────┘
                                                      │               │
                                    POST /print-agent/ack  (PRINTED / FAILED+error)
                                                      │
                              ticket → PRINTED / FAILED, PrintJob → PRINTED / FAILED
                              KDS + POS surfaces read the same statuses they read today
```

Key properties:

- The **outbox rows are the only contract** between order intake and
  printing. Intake never learns whether an agent exists.
- The agent is stateless beyond its config + a tiny crash-recovery journal
  (§10.6): all queue truth lives in the API's database.
- Fallback mode (§9.5) consumes the SAME rows from a browser tab, so a
  branch can switch modes without data changes.

---

## 7. Data model changes

All migrations are **additive**; each ships with its own decision record and
registers in `provider-contract.spec.ts` exactly like the convergence-plan
migrations (list + count + per-migration proof block).

### 7.1 Generalise the printer registry — `KitchenPrinter` → serves both roles

The existing table already holds kind/address/active and has CRUD + UI. Add a
role column instead of a second table:

```prisma
enum PrinterRole {
  KITCHEN   // reached via station links (existing behaviour)
  CASHIER   // reached via register assignment (§7.3)
}

model KitchenPrinter {
  // … existing fields unchanged …
  /// D6x — what this device is for. Existing rows backfill to KITCHEN in the
  /// same migration (their only current use).
  role PrinterRole @default(KITCHEN)
}
```

*Deliberately NOT renamed* (`KitchenPrinter` → `Printer` would be a
rename-migration for zero behaviour). The API/UI vocabulary says “printer”;
the table keeps its name the way `Menu` kept its name for collections
(D66 precedent). A comment on the model records this.

### 7.2 Widen `PrintJob` into the cashier outbox

Today: `saleId` required, `html` payload, three retail types. Changes:

```prisma
enum PrintJobType {
  CUSTOMER_RECEIPT
  WAREHOUSE_PICKING
  RETURN_RECEIPT
  ORDER_BILL          // NEW — pro-forma at placement (dine-in table, delivery)
  ORDER_RECEIPT       // NEW — settled receipt (counter flows, retail parity)
  KITCHEN_TICKET_COPY // NEW — optional expo/pass copy (deferred UI)
}

model PrintJob {
  // existing …
  saleId    String?      // NEW: nullable — an ORDER_BILL at placement has no Sale yet
  orderId   String?      // NEW: RestaurantOrder ref for placement-time bills
  branchId  String?      // NEW: routing scope (backfilled from sale.branchId)
  printerId String?      // NEW: resolved target device (null = fallback/browser)
  registerId String?     // NEW: which till asked, for printer resolution + audit
  /// NEW — rendered ESC/POS payload, base64. `html` stays for the browser
  /// fallback and for legacy rows; exactly one of the two is consumed per mode.
  escposPayload String?
  attempts  PrintJobAttempt[]  // NEW — mirror of KitchenPrintAttempt
}

model PrintJobAttempt {
  id        String   @id @default(cuid())
  tenantId  String
  jobId     String
  printerId String?
  status    KitchenPrintAttemptStatus @default(PENDING) // reuse the enum
  error     String?
  attemptedAt DateTime @default(now())
  completedAt DateTime?
  // relations + indexes mirroring KitchenPrintAttempt
}
```

Why not merge the two queues into one table? The kitchen queue's rows hang
off tickets with their own lifecycle (REPRINTED, KDS semantics) and shipping
code depends on them; a merge is a rewrite with no user-visible win. Instead
the **lease API (§11) presents both queues as one stream** — unification at
the boundary, not in storage. (Same reasoning the convergence plan used for
keeping six report endpoints over one query layer.)

`saleId` becoming nullable is the one non-cosmetic change to existing shape;
a dedicated proof block asserts no existing row is touched and the API's
existing readers (`GET /print-jobs`, bills page) are covered by integration
tests before/after.

### 7.3 Cashier printer assignment

```prisma
model Register {
  // existing …
  /// D6x — the receipt/bill printer at this till. NULL = branch default.
  receiptPrinterId String?
}

model RestaurantBranchConfig {
  // existing …
  /// D6x — auto-printing switches (per branch).
  autoPrintKot          Boolean @default(true)
  autoPrintBill         Boolean @default(true)
  /// Copies of the cashier document per order. 1..3.
  billCopies            Int     @default(1)
  /// NULL = no branch default printer; jobs fall back to browser mode.
  defaultReceiptPrinterId String?
}
```

Retail branches have no `RestaurantBranchConfig`; their switches live in
`TenantSettings` (`autoPrintReceipt Boolean @default(false)` — off by
default so nothing changes for the pilot until they opt in). Resolution
order at enqueue time: `register.receiptPrinterId ?? branchConfig.defaultReceiptPrinterId ?? null(browser fallback)`.

### 7.4 The agent registry

```prisma
model PrintAgent {
  id         String   @id @default(cuid())
  tenantId   String
  branchId   String
  name       String              // "Front counter PC"
  /// Sha256 of the pairing token; the plaintext is shown once (§10.2).
  tokenHash  String   @unique
  isActive   Boolean  @default(true)
  lastSeenAt DateTime?
  version    String?             // agent build, reported on heartbeat
  createdAt  DateTime @default(now())
  // tenant/branch relations, indexes on tenantId, branchId
}
```

---

## 8. Rendering — ESC/POS payloads

### 8.1 Where rendering happens

**Server-side, at enqueue time** (stored on the row), for both queues.
Rationale: the agent stays dumb (no template updates to distribute), the
payload is auditable/replayable byte-for-byte on reprint, and rendering
inside the request keeps using the tenant's D54 document profile
(business name, currency, footer) with no extra fetch. Cost: a few KB per
row; acceptable (tickets are retained anyway; add a 90-day prune job to the
existing maintenance path, §16 Phase 4).

### 8.2 The encoder

A tiny in-repo module — `apps/api/src/common/printing/escpos.ts` — NOT an
npm dependency (the ESC/POS subset needed is ~15 commands; owning it avoids
a supply-chain edge and matches the repo's differential-testing culture).

Command subset (all as named builder methods over a byte buffer):

| Method | Bytes | Use |
|---|---|---|
| `init()` | `1B 40` | reset per document |
| `align(l/c/r)` | `1B 61 n` | headers/totals |
| `bold(on)` | `1B 45 n` | totals, station name |
| `doubleSize(on)` | `1D 21 n` | KOT item lines, ticket number |
| `text(utf8→cp)` | codepage-mapped bytes | body (§8.5) |
| `feed(n)` | `1B 64 n` | spacing |
| `hr()` | `-` × width | separators |
| `cut()` | `1D 56 42 00` | partial cut per document |
| `pulse()` | `1B 70 00 19 FA` | cash-drawer kick (§8.6) |
| `raw(bytes)` | — | escape hatch |

Width handling: 80 mm (48 cols, default) and 58 mm (32 cols) — a printer
gains `columns Int @default(48)` in the same migration as `role`.

### 8.3 KOT template (kitchen printer)

```
        ── GRILL ──            ← station name, double-height, centred
 KOT-000123      RO-000045     ← ticketNumber · orderNumber
 T1 · Main Hall  18:42         ← table/takeaway tag · time
────────────────────────────
 2× Beef Steak     [MEDIUM]    ← qty double-height; variantName right
    + Extra cheese             ← modifierNames, indented
    ! No onions                ← specialInstructions, prefixed !
 1× Kottu
────────────────────────────
 Round 2 · Waiter: Nimal
        (cut)
```

Everything above already exists on `KitchenTicketItem` — no new intake data
needed. Reprints render `*** REPRINT ***` above the header (status
REPRINTED already exists).

### 8.4 Bill / receipt template (cashier printer)

Header from the D54 document profile (business name, branch, address,
currency), then:

- **ORDER_BILL** (pro-forma, at placement): order number, channel chip,
  table/takeaway tag, items with modifiers priced, subtotal / service charge
  / packaging / tax from `computeRestaurantTotals` (the D52 single
  calculator — the template must call it, never re-add), a `*** NOT A
  RECEIPT — ORDER COPY ***` banner, no payment lines.
- **ORDER_RECEIPT / CUSTOMER_RECEIPT** (settled): the same body plus payment
  method, tendered/change, and the Sale number — content parity with the
  existing HTML receipt so the two modes never disagree (a unit test renders
  both from one fixture and diffs the numbers).

### 8.5 Character set

Phase 1 ships CP437 + transliteration fallback (strip diacritics, replace
unknowns with `?`) and records the limitation; the pilot market's names are
Latin. Sinhala/Tamil on thermal printers requires raster-mode text (render
to bitmap, `GS v 0`) — specified as Phase 4 work, flag-gated per printer.

### 8.6 Cash-drawer kick

`pulse()` appended to ORDER_RECEIPT payloads when
`register.kickDrawerOnReceipt` (new Boolean, default false) — included in
the §7.3 migration since it is one column, shipped dark until the UI toggle
lands in Phase 4.

---

## 9. Trigger wiring — where jobs are enqueued

### 9.1 Kitchen (exists, gains a switch)

`generateTicketsForRound` already writes the attempts inside the intake
transaction. Change: consult `branchConfig.autoPrintKot`; when **off**, write
the ticket as today but attempts as a new `SKIPPED`-style terminal status?
**No** — simpler and honest: when off, still write PENDING attempts but the
lease API excludes that branch's kitchen queue; the KDS's manual buttons keep
working on the same rows. (One switch read at lease time, no intake change,
no new enum value.)

### 9.2 Cashier bill (new)

In BOTH intake paths, immediately after `writeRoundItems` (inside the same
tx), when `autoPrintBill`:

```
PrintJob {
  type: ORDER_BILL (or ORDER_RECEIPT for retail /sales/complete parity),
  orderId, branchId, registerId?  ← from the acting session where available,
  printerId: resolved per §7.3 (may be null → browser fallback),
  escposPayload: rendered now (§8),
  copies: branchConfig.billCopies,
}
```

For **dine-in table rounds**, the bill is per-ROUND (an order addendum). PO
decision needed (§14 Q3) on whether round ≥ 2 prints a full running bill or
only the delta; default proposal: full running bill with `Round N` marker.

For the **counter flow** the sequence is create → handover → Sale → payment
within seconds. Printing a pro-forma at create AND a receipt at payment
would double-print. Proposal (§14 Q2): counter/takeaway prints **only** the
ORDER_RECEIPT, enqueued by `billing.collectPayment` (payment step); dine-in
table + delivery print the ORDER_BILL at placement. `closeSession`
additionally enqueues the settled receipt when a table settles.

### 9.3 Flow → document matrix (proposed defaults)

| Flow | At placement (kitchen) | At placement (cashier) | At settlement (cashier) |
|---|---|---|---|
| Dine-in table round | KOTs | ORDER_BILL (running) | ORDER_RECEIPT on close |
| Counter “Dine In” / Takeaway | KOTs | — | ORDER_RECEIPT on payment |
| Delivery | KOTs | ORDER_BILL (rider copy) | ORDER_RECEIPT when settled |
| Retail sale | — | — | CUSTOMER_RECEIPT on complete (existing type, now driveable) |

### 9.4 The one rule intake keeps

Enqueue writes rows and renders bytes; it never opens sockets, never sleeps,
never fails the order. Rendering failure (template bug) must also not fail
the order: wrap render in try/catch, store the job as FAILED with the error
— visible in the queue UI, order intact (mirrors scenario 20).

### 9.5 Browser fallback mode (no agent)

A new lightweight poller in the web app (mounted in the POS shell and the
KDS page, behind the branch config `printTransport: 'AGENT' | 'BROWSER'`):
polls the SAME lease endpoint with the user's session (scoped variant),
renders the `html` payload into the existing named-popup path, auto-calls
`window.print()`, and acks. With Chrome kiosk-printing this is silent; with
a normal browser it shows one dialog per document — degraded but functional.
This is exactly today's manual behaviour with the tap removed, and it is the
migration path for every branch before an agent is installed.

---

## 10. The Print Agent (`apps/print-agent`)

### 10.1 Shape

TypeScript, Node 20, compiled to a single-file executable (pkg/esbuild →
`axlo-print-agent{-linux,-win.exe}`); runs as systemd unit / Windows
service (NSSM script shipped in-repo); ~zero dependencies (net, fs, fetch).
Lives in the monorepo (`apps/print-agent`) sharing lint/test config; it
imports NOTHING from `apps/api` internals — its only contract is the HTTP
API (§11), pinned by a shared contract-test fixture.

### 10.2 Pairing

1. Admin opens Settings → Printing → Agents → “Pair new agent” → API creates
   a `PrintAgent` row and returns the plaintext token **once** (same
   pattern as the reset-password disclosure).
2. On the shop machine: `axlo-print-agent init --api https://api.axlopos.com
   --token <paste>` writes `agent.json` (URL + token + machine name), then
   `--install-service`.
3. Agent boots → `POST /print-agent/heartbeat` → visible as “online” in
   settings within seconds.

### 10.3 Main loop

```
loop:
  jobs = POST /print-agent/lease {maxJobs: 8, waitSeconds: 25}   // long-poll
  for job in jobs:                       // job = {leaseId, printer{kind,address,columns}, payloadB64, copies}
    result = driver(job.printer).print(payload × copies)
    journal.append(leaseId, result)      // crash safety, §10.6
    POST /print-agent/ack {leaseId, status, error?}
  on network error: exponential backoff 1s..60s, keep journal
```

### 10.4 Drivers

- `tcp9100`: connect (3 s timeout) → write → drain → FIN. A refused/timed-out
  connect is a NACK with the socket error verbatim. Optional status-back
  (DLE EOT paper sensor) is Phase 4 — MVP treats a completed TCP write as
  success (industry-standard behaviour for 9100).
- `usb`: platform spool passthrough (`lp -d` / `RAW` to Windows share); listed
  configuration-only in MVP docs, code behind the same driver interface.
- `mock`: append to `spool/*.bin` — used by every agent test and by dev.

### 10.5 Leasing semantics (server side)

- `lease` atomically flips PENDING → LEASED (new enum value on
  `KitchenPrintAttemptStatus`) with `leasedAt`, `agentId`, returning only
  rows for the agent's branch whose printer is agent-reachable
  (`kind != MOCK`… MOCK included in dev). Lease TTL 60 s: an expired lease
  reverts to PENDING (crash recovery), guarded by the journal on the agent
  side to avoid the re-print in the common case.
- `ack PRINTED` → attempt DONE + ticket/job transition (reusing today's
  `markTicketPrinted` transition logic so KDS behaviour is identical to a
  human tap).
- `ack FAILED` → attempt FAILED + error; server schedules a retry attempt
  (new PENDING row) with capped backoff (3 tries: +5 s, +30 s, +120 s), then
  ticket/job → FAILED and the surfaces of §12 light up.

### 10.6 Crash windows, stated honestly

Printed-but-not-acked (agent dies between write and ack): the lease expires,
the row re-queues, the journal replay acks it if the journal survived;
otherwise ONE duplicate print after agent restart. Duplicate-vs-lost is the
N1 trade and duplicates are chosen, matching the reprint button's semantics.

### 10.7 Time & ordering

Per printer, the agent prints leases in server-issued order (the lease
response is ordered by `createdAt`); the server never leases two jobs for
the same printer to two agents (printer-scoped lease lock) so tickets cannot
interleave out of order across agents.

### 10.8 Ops surface

`axlo-print-agent doctor` — prints config, API reachability, and a test-page
to every configured printer. Heartbeat carries version; the settings screen
shows stale agents. Log to a rotating file, 7 days.

---

## 11. API surface (new)

All under `/print-agent/*`, authenticated by the agent token (a new
lightweight `AgentTokenGuard` — NOT a user JWT; the token maps to
`PrintAgent → {tenantId, branchId}` and is refused everywhere else, the same
boundary discipline as `PlatformBoundaryGuard`). Every route lands in the
route-matrix spec with an `AGENT` classification note.

| Method | Path | Purpose |
|---|---|---|
| POST | `/print-agent/heartbeat` | liveness + version; returns branch print config (mode, switches) |
| POST | `/print-agent/lease` | long-poll: atomically lease ≤ N payloads across both queues |
| POST | `/print-agent/ack` | terminal outcome per lease |
| GET  | `/print-agent/test-page/:printerId` | render a self-test payload (doctor) |

Management (user-JWT, SETTINGS-gated):

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/branches/:branchId/print-agents` | list / pair (returns plaintext token once) |
| PATCH/DELETE | `/print-agents/:agentId` | rename / revoke |
| GET | `/branches/:branchId/print-queue` | unified queue view (depth, failures) for the settings screen |
| POST | `/print-jobs/:id/retry` | operator retry for a FAILED cashier job |

Existing kitchen endpoints are untouched — the KDS keeps working unchanged.

---

## 12. Configuration & operator UI

1. **Settings → Printing** (new page, SETTINGS module):
   - Printers table (extends the kitchen-printers screen to both roles):
     code, name, role, kind, address, columns, active, **Test print**.
   - Register assignments: per register, a cashier-printer select.
   - Branch switches: auto-print KOT / bill, copies, transport
     (Agent / Browser), default cashier printer.
   - Agents: list with online/last-seen/version, Pair, Revoke.
2. **KDS / kitchen board:** unchanged UI, but tickets now normally arrive
   already PRINTED; a FAILED ticket shows the existing red state with the
   attempt error (printer name + socket error) and the existing Reprint.
3. **POS:** a small toast on bill-job failure (“Bill didn’t print on
   ‘Front Desk’ — reprint from Bills”), and a Reprint action on the bill/
   sale views that enqueues a fresh job (never re-acks the old one).

---

## 13. Testing plan (D30 discipline)

- **Encoder unit spec:** byte-exact golden buffers per command; template
  specs render fixture tickets/bills and assert the byte stream (snapshot of
  hex), both widths; a differential test renders the HTML receipt and the
  ESC/POS receipt from one fixture and asserts the same numbers appear in
  both (mirrors the D59 differential style).
- **Enqueue integration:** placing an order (both intake paths) writes the
  bill job + attempts in the SAME tx (assert rows exist when the response
  returns; assert a thrown render leaves the order intact and the job
  FAILED); switches respected per branch; printer resolution order
  (register → branch default → null) pinned with all three cases.
- **Lease/ack contract integration:** lease flips atomically (two concurrent
  leases share no row — the exact-set assertion, not a count); TTL expiry
  re-queues; ack transitions mirror the manual mark-printed transitions
  byte-for-byte (same service method, asserted by spy); FAILED schedules
  bounded retries then stops (negative: no 4th attempt row).
- **Agent contract tests** (in `apps/print-agent`): loop against a stub API
  + `mock` driver spool; crash-journal replay case; backoff case.
- **Tripwire:** a structural spec asserting intake services never import a
  socket/driver module (printing stays behind the outbox) — positive control
  that the agent driver DOES.
- **e2e smoke:** place a counter order with a MOCK printer configured; poll
  the spool dir via a test hook; assert the KOT and receipt payloads landed.

---

## 14. Open decisions for the PO (blockers marked ⛔)

- **Q1 ⛔ Hardware reality:** which printer models/interfaces do the pilot
  shops actually have (network 9100? USB-only? 80 mm?)? Decides whether the
  USB driver is MVP or Phase 4 and validates the CP437 assumption.
- **Q2 ⛔ Counter double-print:** accept the §9.3 default (counter prints
  only the settled receipt at payment; no pro-forma seconds earlier)?
- **Q3:** dine-in round ≥ 2 — full running bill (default) or delta-only?
- **Q4:** should the cashier bill ALSO print automatically on table close
  (settled receipt) or stay behind the existing cashier tap? Default: auto.
- **Q5:** browser-fallback mode as MVP week-1 deliverable before the agent
  ships (recommended: yes — it exercises the whole queue with zero install)?
- **Q6:** retention for rendered payloads (proposed 90 days, pruned).

---

## 15. Delivery phases

| Phase | Contents | Effort | Exit criterion |
|---|---|---|---|
| **P1 — outbox + rendering** | §7 migrations (+records), ESC/POS encoder + KOT/bill templates, enqueue wiring both intake paths, switches, printer-resolution; browser-fallback poller (Q5) | 5–8 d | placing an order produces byte-ready jobs; a kiosk-mode browser prints both documents hands-free in dev |
| **P2 — lease API + agent MVP** | lease/ack/heartbeat + guard + route matrix; agent binary with tcp9100 + mock drivers, pairing, journal; settings page (printers, agents, switches) | 8–12 d | MOCK + a real network printer print KOT + receipt ≤ 3 s after placement, failure surfaces on KDS/POS, reprint works |
| **P3 — hardening** | retries/backoff tuning, queue observability, stale-agent surfacing, payload prune, retail receipt opt-in, e2e smoke in CI | 3–5 d | pilot branch runs a full service day with zero manual taps |
| **P4 — optional scope** | USB driver, A4_NETWORK via PDF, drawer kick UI, DLE EOT paper status, raster fonts (Sinhala/Tamil), expo copies | on demand | per-item |

Each phase ends with its decision record, the full gate suite, and a live
demo against dev hardware (a software ESC/POS emulator — e.g. writing MOCK
spool files rendered by an offline viewer — is part of P1's dev tooling).

---

## 16. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Shop hardware is USB-only (Q1) | agent MVP can't drive it | browser-fallback mode day 1; USB driver pulled into P2 if Q1 says so |
| Duplicate prints in crash windows | kitchen confusion | journal + lease TTL (§10.6); REPRINT banner marks non-first prints |
| Agent install friction | rollout stalls | single binary + `init` + `doctor`; fallback mode indefinitely viable |
| Template/money drift between HTML and ESC/POS | wrong totals printed | one calculator (D52) called by both; differential render test (§13) |
| Payload bloat in DB | storage growth | 90-day prune (Q6); payloads are KBs |
| New always-on component to support | ops load | heartbeat surfacing, versioned binary, logs, MOCK-driver reproducibility |

---

## Appendix A — example lease response

```json
{
  "jobs": [
    {
      "leaseId": "lease_01H…",
      "source": "KITCHEN",            // KITCHEN | CASHIER
      "printer": { "id": "prn_grill", "kind": "ESC_POS_NETWORK",
                    "address": "192.168.8.50:9100", "columns": 48 },
      "copies": 1,
      "payloadB64": "G0AbYQEdIRFHUklMTA…"
    }
  ],
  "waitedMs": 480
}
```

## Appendix B — agent config (`agent.json`)

```json
{
  "apiUrl": "https://api.axlopos.com",
  "token": "pat_…(plaintext, chmod 600)",
  "name": "Front counter PC",
  "journalDir": "/var/lib/axlo-print-agent"
}
```
